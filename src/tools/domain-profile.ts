import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RateLimitError, type DomainProfile, type ShieldLabsManagement } from '@shieldlabs-ai/node';
import { z } from 'zod';
import { PROFILE_CACHE_MS, TOOL_NAMES } from '../constants.js';
import type { ServerContext, SharedRequest } from '../context.js';
import { ToolInputError } from '../errors.js';
import { code, formatTimestamp } from '../format.js';
import { failure, readOnlyAnnotations, respond, ResponseFormatSchema } from './shared.js';
import { nullableString } from '../schema.js';

const OutputSchema = z.object({
  domain: z.string(),
  remaining_identifications: z
    .number()
    .int()
    .describe(
      'Remaining included identifications; negative when the account is over its included volume',
    ),
  public_key_masked: z.string(),
  secret_key_masked: z.string(),
  created_at: nullableString('When the domain was created, RFC 3339 UTC'),
  fetched_at: z.string(),
  from_cache: z.boolean(),
});

type ProfileOutput = z.infer<typeof OutputSchema>;

/** After a 429 the Management API blocks the IP for 10 minutes. */
export const MANAGEMENT_BLOCK_MS = 10 * 60 * 1000;

/** Rejects as soon as `signal` aborts, otherwise settles like `promise`. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  const reason = (): Error =>
    signal.reason instanceof Error ? signal.reason : new Error('The tool call was cancelled.');
  let onAbort = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(reason());
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    signal.removeEventListener('abort', onAbort);
  });
}

/**
 * Reads the profile, sharing one request between concurrent calls (the Management API allows
 * about 15 calls per minute per IP). A cancelled call stops waiting; the request is aborted only
 * when every waiting call was cancelled. A successful result fills the cache; a 429 blocks further
 * calls for the ban window.
 */
async function loadProfile(
  ctx: ServerContext,
  management: ShieldLabsManagement,
  signal: AbortSignal | undefined,
): Promise<DomainProfile> {
  let request = ctx.profileRequest;
  if (request === undefined) {
    const startedAt = ctx.now();
    const controller = new AbortController();
    const created: SharedRequest<DomainProfile> = {
      controller,
      waiters: 0,
      promise: management.getProfile({ signal: controller.signal }).then(
        (value) => {
          ctx.profileCache = { value, fetchedAt: startedAt };
          return value;
        },
        (error: unknown) => {
          if (error instanceof RateLimitError) {
            const retryAfterMs = (error.retryAfter ?? 0) * 1000;
            ctx.profileBlockedUntil = ctx.now() + Math.max(MANAGEMENT_BLOCK_MS, retryAfterMs);
          }
          throw error;
        },
      ),
    };
    const clear = (): void => {
      if (ctx.profileRequest === created) ctx.profileRequest = undefined;
    };
    created.promise.then(clear, clear);
    ctx.profileRequest = created;
    request = created;
  }
  const shared = request;
  shared.waiters += 1;
  try {
    return await untilAborted(shared.promise, signal);
  } finally {
    shared.waiters -= 1;
    if (shared.waiters === 0 && ctx.profileRequest === shared) {
      // Every caller gave up while the request was still running.
      ctx.profileRequest = undefined;
      shared.controller.abort();
    }
  }
}

function blockedMessage(blockedUntil: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((blockedUntil - now) / 60_000));
  return `the Management API rate limit was reached (HTTP 429). It blocks the IP for 10 minutes after about 15 calls per minute, so this server does not call it again before ${formatTimestamp(new Date(blockedUntil).toISOString())} (in about ${minutes} minute${minutes === 1 ? '' : 's'}). Call shieldlabs_get_domain_profile again after that.`;
}

function profileMarkdown(output: ProfileOutput): string {
  const lines = [
    `# Domain profile: ${code(output.domain)}`,
    '',
    `- Remaining included identifications: ${output.remaining_identifications.toLocaleString('en-US')}${output.remaining_identifications < 0 ? ' (negative: the account is over its included volume)' : ''}`,
    `- Public Key (masked): ${code(output.public_key_masked)}`,
    `- Secret Key (masked): ${code(output.secret_key_masked)}`,
    `- Domain created: ${formatTimestamp(output.created_at)}`,
    '',
    `Fetched ${formatTimestamp(output.fetched_at)}${output.from_cache ? ' (cached)' : ''}. This server caches the profile for ${PROFILE_CACHE_MS / 1000} s because the Management API allows about 15 calls per minute per IP.`,
  ];
  return lines.join('\n');
}

export function registerGetDomainProfile(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TOOL_NAMES.getDomainProfile,
    {
      title: 'Get domain profile',
      description: `Read the domain profile from the ShieldLabs Management API: the registered domain, the remaining included identifications of the account (negative when over the included volume), the masked Public Key and Secret Key, and when the domain was created.

Rate limit: the Management API allows about 15 calls per minute per IP and then blocks the IP for 10 minutes. Call this tool sparingly; this server caches the result for ${PROFILE_CACHE_MS / 1000} seconds, shares one request between concurrent calls, and after a 429 answers from memory until the block ends.

Args:
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "domain": string, "remaining_identifications": number, "public_key_masked": string, "secret_key_masked": string, "created_at": string | null, "fetched_at": string, "from_cache": boolean }`,
      inputSchema: z.object({ response_format: ResponseFormatSchema }).strict(),
      outputSchema: OutputSchema,
      annotations: readOnlyAnnotations('Get domain profile', true),
    },
    async ({ response_format }, extra) => {
      try {
        if (ctx.management === undefined) {
          throw new ToolInputError(
            'the Management API is not configured. Set SHIELDLABS_SECRET_KEY and SHIELDLABS_DOMAIN and restart the server.',
          );
        }
        const now = ctx.now();
        let cached = ctx.profileCache;
        const fromCache = cached !== undefined && now - cached.fetchedAt < PROFILE_CACHE_MS;
        if (!fromCache) {
          if (ctx.profileBlockedUntil !== undefined && now < ctx.profileBlockedUntil) {
            throw new ToolInputError(blockedMessage(ctx.profileBlockedUntil, now));
          }
          await loadProfile(ctx, ctx.management, extra.signal);
          cached = ctx.profileCache;
        }
        const { value: profile, fetchedAt } = cached as NonNullable<typeof cached>;
        const output: ProfileOutput = {
          domain: profile.domain,
          remaining_identifications: Math.trunc(profile.remaining_identifications),
          public_key_masked: profile.public_key_masked,
          secret_key_masked: profile.secret_key_masked,
          created_at: profile.created_at,
          fetched_at: new Date(fetchedAt).toISOString(),
          from_cache: fromCache,
        };
        return respond(ctx, output, profileMarkdown(output), response_format);
      } catch (error) {
        return failure(ctx, error, 'management');
      }
    },
  );
}
