import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import { ToolInputError } from '../errors.js';
import {
  buildExplanation,
  ExplanationSchema,
  fromIdentification,
  parseIdentificationInput,
} from '../explain.js';
import { notFoundMessage } from './get-identification.js';
import {
  failure,
  readOnlyAnnotations,
  RequestIdSchema,
  requireHistory,
  respond,
  ResponseFormatSchema,
} from './shared.js';

const InputSchema = z
  .object({
    request_id: RequestIdSchema.optional().describe(
      'Request ID of the identification to explain, read from the History API (needs SHIELDLABS_API_KEY; waits up to about 10 seconds for a new identification, like shieldlabs_get_identification). Give either request_id or identification.',
    ),
    identification: z
      .union([
        z.record(z.string(), z.unknown()).meta({ additionalProperties: true }),
        z.string().max(500_000),
      ])
      .optional()
      .describe(
        'An identification to explain without an API call: a normalized identification (for example the json output of shieldlabs_get_identification), a webhook event or its data object, or a raw History API row. A JSON object or its JSON text.',
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

export function registerExplainRiskScore(server: McpServer, ctx: ServerContext): void {
  const historyNote =
    ctx.history === undefined
      ? ' SHIELDLABS_API_KEY is not set on this server, so pass the identification itself; request_id lookups are not available.'
      : '';
  server.registerTool(
    TOOL_NAMES.explainRiskScore,
    {
      title: 'Explain Risk Score',
      description: `Explain why an identification got its Risk Score: the band (trusted 0-29, suspicious 30-59, dangerous 60-100, or the 999 rate-limit marker), each weighted risk signal with a plain-language meaning from the catalog bundled with this server, the detection flags that are set, the connection type and caveats.${historyNote}

Args:
  - request_id (string, optional): read the identification from the History API, waiting up to about 10 s for a new one
  - identification (object or JSON string, optional): explain a pasted identification instead (normalized identification, webhook event or data object, or raw History API row)
  - response_format ('markdown' | 'json'): default 'markdown'
Give exactly one of request_id and identification.

Returns (json): { "request_id": string | null, "risk_score": number, "risk_band": "trusted" | "suspicious" | "dangerous" | "rate_limited", "band_range": string, "band_meaning": string, "signals": [{ name, weight, label, meaning, reading, typical_weight, related_flag, in_catalog }], "detection_flags": [{ flag, label, scored, meaning }], "connection_type": { value, label, meaning } | null, "notes": [string], "source": "history" | "webhook" | "input", "truncated"?: true, "truncation_message"?: string }

A pasted risk_score must be an integer from 0 to 100, or the 999 rate-limit marker, and weights must be integers. Weights come from the identification itself; the catalog's typical weights can change, and signal names outside the catalog are possible. The catalog is also available as the resource shieldlabs://reference/risk-signals.`,
      inputSchema: InputSchema,
      outputSchema: ExplanationSchema,
      annotations: readOnlyAnnotations('Explain Risk Score', ctx.history !== undefined),
    },
    async ({ request_id, identification, response_format }, extra) => {
      try {
        if ((request_id === undefined) === (identification === undefined)) {
          throw new ToolInputError(
            'give exactly one of request_id (read from the History API) or identification (a pasted identification).',
          );
        }
        let input;
        if (request_id !== undefined) {
          const client = requireHistory(ctx);
          const found = await client.identifications.get(request_id, {
            timeout: ctx.waitTimeoutMs,
            signal: extra.signal,
          });
          if (found === null) {
            throw new ToolInputError(
              notFoundMessage(request_id.toLowerCase(), true, Math.round(ctx.waitTimeoutMs / 1000)),
            );
          }
          input = fromIdentification(found);
        } else {
          input = await parseIdentificationInput(identification);
        }
        const { explanation, markdown } = buildExplanation(input);
        return respond(
          ctx,
          explanation,
          markdown,
          response_format,
          'Explain fewer risk signals at a time.',
        );
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
