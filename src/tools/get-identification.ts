import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { HISTORY_TIMING, REFINEMENT_ADVICE, TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import { ToolInputError } from '../errors.js';
import { UNTRUSTED_DATA_FIELD_NOTE, UNTRUSTED_DATA_NOTE } from '../format.js';
import {
  IdentificationOutputSchema,
  identificationMarkdown,
  toIdentificationOutput,
} from '../identification.js';
import {
  failure,
  MARKDOWN_HINT,
  readOnlyAnnotations,
  RequestIdSchema,
  requireHistory,
  respond,
  ResponseFormatSchema,
} from './shared.js';

const InputSchema = z
  .object({
    request_id: RequestIdSchema,
    wait: z
      .boolean()
      .default(true)
      .describe(
        'Wait for the verdict when the identification is not stored yet, polling for up to about 10 seconds in total (default true). Use false to read once, for example to read a refined verdict again.',
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

/** Actionable text for an identification that is not (yet) in the History API. */
export function notFoundMessage(requestId: string, waited: boolean, waitSeconds: number): string {
  const intro = waited
    ? `No identification with request ID ${requestId} is available yet (waited about ${waitSeconds} s).`
    : `No identification with request ID ${requestId} was found (read once, without waiting).`;
  const next = waited
    ? 'If the browser call just happened, try again in a few seconds. If it is older, check that the request ID came from this domain (the Private API Key reads one domain only); a request ID issued while the visitor IP was over the ingest rate limit is never stored.'
    : 'If the browser call just happened, call again with wait=true.';
  return `${intro} ${HISTORY_TIMING} ${next} Treat a missing identification as unverified, never as clean.`;
}

export function registerGetIdentification(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TOOL_NAMES.getIdentification,
    {
      title: 'Get identification',
      description: `Read the verdict of one identification by its request ID from the ShieldLabs History API: Risk Score and band, weighted risk signals, the 19 detection flags, visitor, device, cookie and session IDs, User HID, public and local IP with country, connection type, OS, browser and traffic source.

Use it when you have the request ID of a protected action (signup, login, payment) and need its verdict. The browser only ever sees the request ID; the verdict is read here, server-side.

${HISTORY_TIMING} This tool returns the first version of the row it finds. ${REFINEMENT_ADVICE} Integrations that start the identification when the user begins the action (for example on the first interaction with a form) find the row stored by the time the action reaches their backend.

With wait=true it polls for up to about 10 seconds in total. A 429, a 5xx or a network error does not end the wait (its error is returned only when the last poll failed); a wrong key or base URL ends it at once.

Args:
  - request_id (string): UUID returned by the browser agent
  - wait (boolean): poll until the verdict is stored, for up to about 10 s in total (default true); false reads once
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "found": true, "identification": { request_id, visitor_id, device_id, session_id, cookie_id, user_hid, domain, public_ip: { ip, country }, local_ip: { ip, country }, connection_type, os, browser, device_type, traffic_source: { channel, referrer_domain, landing_url, click_id_type, utm_source, utm_medium, utm_campaign, utm_content, utm_term }, risk_score, risk_band, signals: [{ name, weight, description: null }], detection_flags: { vpn, proxy, tor, ... }, observed_at, source, truncated_fields?, escaped_fields? }, "untrusted_data_note": string }

Errors: an error result when no identification is stored for the request ID (treat it as unverified, never as clean), when the key is wrong (401), or when the rate limit (429) or a server or network error prevents the read.

Next steps: shieldlabs_explain_risk_score explains the score; shieldlabs_summarize_entity with the device_id or user_hid shows the history around it.`,
      inputSchema: InputSchema,
      outputSchema: z.object({
        found: z.literal(true),
        identification: IdentificationOutputSchema,
        untrusted_data_note: z.string(),
      }),
      annotations: readOnlyAnnotations('Get identification', true),
    },
    async ({ request_id, wait, response_format }, extra) => {
      try {
        const client = requireHistory(ctx);
        const identification = await client.identifications.get(request_id, {
          wait,
          timeout: ctx.waitTimeoutMs,
          signal: extra.signal,
        });
        if (identification === null) {
          throw new ToolInputError(
            notFoundMessage(request_id.toLowerCase(), wait, Math.round(ctx.waitTimeoutMs / 1000)),
          );
        }
        const item = toIdentificationOutput(identification);
        const markdown = [
          `# Identification ${item.request_id}`,
          '',
          UNTRUSTED_DATA_NOTE,
          '',
          ...identificationMarkdown(item, '##'),
        ].join('\n');
        return respond(
          ctx,
          { found: true, identification: item, untrusted_data_note: UNTRUSTED_DATA_FIELD_NOTE },
          markdown,
          response_format,
          MARKDOWN_HINT,
        );
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
