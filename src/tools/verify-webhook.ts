import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  webhooks,
  WebhookParseError,
  type WebhookEvent,
  type WebhookSecret,
} from '@shieldlabs-ai/node';
import { z } from 'zod';
import { bandOf } from '../catalog/bands.js';
import { splitSecrets } from '../config.js';
import { TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import { ToolInputError } from '../errors.js';
import { code, escapeInvisible, shorten } from '../format.js';
import { RiskBandSchema } from '../identification.js';
import { failure, readOnlyAnnotations, respond, ResponseFormatSchema } from './shared.js';
import { nullableString } from '../schema.js';

const HEADER_FORMAT = /^sha256=[0-9a-fA-F]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Bodies up to this size get the body-change diagnostics. A ShieldLabs delivery is a few
 * kilobytes, so larger payloads are not deliveries and only the signature itself is checked.
 */
export const DIAGNOSE_MAX_BYTES = 64 * 1024;

const InputSchema = z
  .object({
    payload: z
      .string()
      .min(1, 'payload must not be empty')
      .max(1_000_000, 'payload must be at most 1,000,000 characters')
      .describe(
        'The raw request body exactly as received: the bytes that were signed. Do not pretty-print, re-serialize or trim it.',
      ),
    signature_header: z
      .string()
      .max(2_000)
      .describe('Value of the X-Shield-Signature header, for example "sha256=ea26857...fdd8"'),
    secret: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe(
        'Endpoint signing secret including its whsec_ prefix, or several separated by commas while you rotate. Defaults to SHIELDLABS_WEBHOOK_SECRET from the server environment.',
      ),
    payload_encoding: z
      .enum(['utf8', 'base64'])
      .default('utf8')
      .describe(
        "'utf8' (default) when payload is the body text; 'base64' when payload is the body bytes encoded as base64 (use it when exact bytes such as a trailing newline matter)",
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

const OutputSchema = z.object({
  valid: z.boolean(),
  secret_source: z.enum(['argument', 'environment']),
  secrets_checked: z
    .number()
    .int()
    .describe('How many signing secrets were checked (several while a secret is rotated)'),
  matched_secret: z
    .number()
    .int()
    .nullable()
    .describe('Position, from 1, of the secret that matches, in the order given; null when none'),
  checks: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),
  event: z
    .object({
      event_type: z.string(),
      schema_version: z.string(),
      created_at: z.string(),
      request_id: nullableString('Request ID of an identification.scored event'),
      risk_score: z.number().int().nullable(),
      risk_band: RiskBandSchema.nullable(),
    })
    .nullable(),
  hint: nullableString('What to fix when the signature does not match'),
});

type VerifyOutput = z.infer<typeof OutputSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodePayload(payload: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') return encoder.encode(payload);
  const compact = payload.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 === 1) {
    throw new ToolInputError(
      'payload is not valid base64. Use payload_encoding="utf8" for body text.',
    );
  }
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

function escapeLikeSender(text: string): string {
  return text.replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function compactJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Common ways a body gets changed between receipt and verification. When one of them makes the
 * signature match, the caller learns what their code did to the body. Only a yes/no per variant
 * is revealed, never a signature. Every variant is computed in linear time.
 */
export function diagnoseChangedBody(
  bytes: Uint8Array,
  header: string,
  secret: WebhookSecret,
): string | undefined {
  const text = decoder.decode(bytes);
  const compact = compactJson(text);
  const variants: [string, string | undefined][] = [
    ['removing trailing whitespace or a trailing newline', text.trimEnd()],
    ['converting CRLF line endings to LF', text.replace(/\r\n/g, '\n')],
    [
      'escaping &, < and > as \\u0026, \\u003c and \\u003e (the sender escapes them, so the body was decoded and re-encoded)',
      escapeLikeSender(text),
    ],
    ['compacting the JSON (the body was pretty-printed or re-serialized)', compact],
    [
      'compacting the JSON and escaping &, < and > as the sender does (the body was parsed and re-serialized)',
      compact === undefined ? undefined : escapeLikeSender(compact),
    ],
  ];
  for (const [description, candidate] of variants) {
    if (candidate === undefined || candidate === text) continue;
    if (webhooks.verifySignature(candidate, header, secret)) return description;
  }
  return undefined;
}

/** How deliveries work today and what a handler must do. */
export const WEBHOOK_DELIVERY_NOTE =
  'verify the raw body before parsing it and answer 2xx within 1 second. ShieldLabs sends one delivery per identification today (1 second timeout, no retries); later releases add retries that resend identical bytes, so make the handler idempotent on data.request_id. Use the History API for guaranteed reads and for the latest state.';

/** Longest event field shown in the summary; real values are a few dozen characters. */
const MAX_EVENT_FIELD_LENGTH = 200;

/** The rate-limit marker: the only valid risk_score above 100. */
const RATE_LIMIT_MARKER = 999;

/** True for the values a Risk Score can take: an integer from 0 to 100, or the 999 marker. */
function isValidRiskScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    ((value >= 0 && value <= 100) || value === RATE_LIMIT_MARKER)
  );
}

/** The summary of an authentic event, and a failed check when its risk_score is not valid. */
function eventSummary(event: WebhookEvent): {
  summary: NonNullable<VerifyOutput['event']>;
  problem: VerifyOutput['checks'][number] | undefined;
} {
  const scored = event.event_type === 'identification.scored' ? event : undefined;
  // The body is signed by whoever holds the secret, so its text is shown as inert data.
  const field = (value: unknown): string =>
    shorten(escapeInvisible(String(value)), MAX_EVENT_FIELD_LENGTH);
  const score: unknown = scored?.data.risk_score;
  const valid = scored !== undefined && isValidRiskScore(score);
  return {
    summary: {
      event_type: field(event.event_type),
      schema_version: field(event.schema_version),
      created_at: field(event.created_at),
      request_id: scored === undefined ? null : field(scored.data.request_id),
      risk_score: valid ? score : null,
      risk_band: valid ? bandOf(score) : null,
    },
    problem:
      scored === undefined || valid
        ? undefined
        : {
            check: 'event',
            ok: false,
            detail: `The body is authentic but its risk_score ${shorten(typeof score === 'string' ? JSON.stringify(score) : String(score), 40)} is outside 0-100 and the ${RATE_LIMIT_MARKER} rate-limit marker, so no Risk Score is reported for it.`,
          },
  };
}

function verifyMarkdown(output: VerifyOutput): string {
  const lines = [`# Webhook signature: ${output.valid ? 'valid' : 'not valid'}`, ''];
  for (const check of output.checks) {
    lines.push(`- ${check.ok ? 'OK' : 'Problem'}: ${check.detail}`);
  }
  if (output.event !== null) {
    const event = output.event;
    lines.push(
      '',
      '## Event',
      `- Event type: ${code(event.event_type)} (schema ${code(event.schema_version)})`,
    );
    lines.push(`- Created at: ${code(event.created_at)}`);
    if (event.request_id !== null) lines.push(`- Request ID: ${code(event.request_id)}`);
    if (event.risk_score !== null) {
      lines.push(
        `- Risk Score: ${event.risk_score}${event.risk_band === 'rate_limited' ? ' (rate-limit marker, not a Risk Score)' : ` (${event.risk_band})`}`,
      );
    }
  }
  if (output.hint !== null) lines.push('', '## What to fix', output.hint);
  lines.push('', `Reminder: ${WEBHOOK_DELIVERY_NOTE}`);
  return lines.join('\n');
}

/** The whsec_ prefix check over every secret, naming the ones without it. */
function prefixCheck(keys: readonly string[]): VerifyOutput['checks'][number] {
  const missing = keys.flatMap((key, index) => (key.startsWith('whsec_') ? [] : [index]));
  if (missing.length === 0) {
    return {
      check: 'secret_prefix',
      ok: true,
      detail:
        keys.length === 1
          ? 'The secret includes its whsec_ prefix.'
          : `Each of the ${keys.length} secrets includes its whsec_ prefix.`,
    };
  }
  const positions = missing.map((index) => String(index + 1));
  const last = positions.pop() as string;
  const listed = positions.length === 0 ? last : `${positions.join(', ')} and ${last}`;
  const names =
    keys.length === 1
      ? 'The secret does not'
      : missing.length === 1
        ? `Secret ${listed} of ${keys.length} does not`
        : `Secrets ${listed} of ${keys.length} do not`;
  return {
    check: 'secret_prefix',
    ok: false,
    detail: `${names} start with whsec_. The key is the full signing secret including the whsec_ prefix, exactly as shown for the endpoint in the analytics dashboard.`,
  };
}

export function registerVerifyWebhookSignature(server: McpServer, ctx: ServerContext): void {
  const defaultSecret =
    ctx.config.webhookSecret === undefined
      ? 'SHIELDLABS_WEBHOOK_SECRET is not set on this server, so pass secret.'
      : 'When secret is omitted, SHIELDLABS_WEBHOOK_SECRET from the server environment is used.';
  server.registerTool(
    TOOL_NAMES.verifyWebhookSignature,
    {
      title: 'Verify webhook signature',
      description: `Check a received ShieldLabs webhook delivery: does its X-Shield-Signature header match the raw body for the endpoint signing secret? For debugging a webhook endpoint. ${defaultSecret}

The signature is "sha256=" plus the lowercase hex HMAC-SHA256 of the raw body, keyed with the full signing secret including its whsec_ prefix. While a secret is rotated, give several secrets separated by commas (in secret or in SHIELDLABS_WEBHOOK_SECRET): the delivery is valid when any of them matches, and matched_secret tells which. When the signature does not match a body of up to 64 KB, the tool tests common body changes (re-serialized JSON, unescaped characters, added newline) and says which one explains the mismatch. It never returns a secret or an expected signature.

Args:
  - payload (string): raw body exactly as received
  - signature_header (string): value of X-Shield-Signature
  - secret (string, optional): whsec_... signing secret of the endpoint, or several separated by commas
  - payload_encoding ('utf8' | 'base64'): default 'utf8'
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "valid": boolean, "secret_source": "argument" | "environment", "secrets_checked": number, "matched_secret": number | null, "checks": [{ check, ok, detail }], "event": { event_type, schema_version, created_at, request_id, risk_score, risk_band } | null, "hint": string | null }`,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: readOnlyAnnotations('Verify webhook signature', false),
    },
    ({ payload, signature_header, secret, payload_encoding, response_format }) => {
      try {
        const keys = splitSecrets(secret ?? ctx.config.webhookSecret);
        if (keys.length === 0) {
          throw new ToolInputError(
            'no signing secret. Pass secret (the endpoint signing secret, whsec_..., or several separated by commas while you rotate) or set SHIELDLABS_WEBHOOK_SECRET for this server.',
          );
        }
        const bytes = decodePayload(payload, payload_encoding);
        const headerWellFormed = HEADER_FORMAT.test(signature_header.trim());
        const checks: VerifyOutput['checks'] = [
          {
            check: 'header_format',
            ok: headerWellFormed,
            detail: headerWellFormed
              ? 'The header has the form sha256=<64 hex characters>.'
              : 'The header must be "sha256=" followed by 64 hexadecimal characters, exactly as the X-Shield-Signature header arrived.',
          },
          prefixCheck(keys),
        ];
        const matched = keys.findIndex((key) =>
          webhooks.verifySignature(bytes, signature_header, key),
        );
        const valid = matched !== -1;
        const several = keys.length > 1;
        checks.push({
          check: 'signature',
          ok: valid,
          detail: valid
            ? `The header matches the HMAC-SHA256 of the body with ${several ? `secret ${matched + 1} of ${keys.length}` : 'this secret'}.`
            : `The header does not match the HMAC-SHA256 of the body with ${several ? `any of the ${keys.length} secrets` : 'this secret'}.`,
        });

        let event: VerifyOutput['event'] = null;
        let hint: string | null = null;
        if (valid) {
          try {
            const { summary, problem } = eventSummary(
              webhooks.constructEvent(bytes, signature_header, keys[matched] as string),
            );
            event = summary;
            if (problem !== undefined) checks.push(problem);
          } catch (error) {
            if (!(error instanceof WebhookParseError)) throw error;
            checks.push({
              check: 'event',
              ok: false,
              detail: `The body is authentic but is not a usable event: ${error.message}`,
            });
          }
        } else if (headerWellFormed && bytes.length > DIAGNOSE_MAX_BYTES) {
          hint = `The body is larger than ${DIAGNOSE_MAX_BYTES / 1024} KB, so common body changes were not tested. A ShieldLabs delivery is a few kilobytes: check that the payload is one delivery body exactly as received, that ${several ? 'one of the secrets' : 'the secret'} belongs to this endpoint and that it includes the whsec_ prefix.`;
        } else if (headerWellFormed) {
          const change = diagnoseChangedBody(bytes, signature_header, keys);
          hint =
            change === undefined
              ? `Check that ${several ? 'one of the secrets' : 'the secret'} belongs to this endpoint (each endpoint has its own, and rotating replaces it at once), that it includes the whsec_ prefix, and that the payload is the raw body exactly as received, before any JSON parsing.`
              : `The signature matches the body after ${change}. Your code changed the body before verifying it: verify the raw bytes exactly as received.`;
        } else {
          hint =
            'Pass the X-Shield-Signature header value unchanged, for example sha256=<64 hex characters>.';
        }

        const output: VerifyOutput = {
          valid,
          secret_source: secret === undefined ? 'environment' : 'argument',
          secrets_checked: keys.length,
          matched_secret: valid ? matched + 1 : null,
          checks,
          event,
          hint,
        };
        return respond(ctx, output, verifyMarkdown(output), response_format);
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
