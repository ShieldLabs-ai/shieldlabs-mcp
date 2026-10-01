import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShieldLabs } from '@shieldlabs-ai/node';
import { z } from 'zod';
import { ENTITY_TYPES, TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import {
  code,
  formatTimestamp,
  UNTRUSTED_DATA_FIELD_NOTE,
  UNTRUSTED_DATA_NOTE,
} from '../format.js';
import { toIdentificationOutput, type IdentificationOutput } from '../identification.js';
import { SummarySchema, summarize, type Summary } from '../summarize.js';
import { checkLookupValue, lookupValueSchema } from './search-history.js';
import {
  failure,
  MARKDOWN_HINT,
  readOnlyAnnotations,
  requireHistory,
  respond,
  ResponseFormatSchema,
} from './shared.js';

const PAGE_SIZE = 100;

/** Default and ceiling of max_items: each 100 identifications cost one History API request. */
export const DEFAULT_MAX_ITEMS = 100;
export const MAX_MAX_ITEMS = 500;

export const COMPUTED_FROM_NOTE =
  'Computed by this MCP server from the identifications returned by the History API in the window below. It is an aggregate of that history window, not a verdict from ShieldLabs.';

const InputSchema = z
  .object({
    type: z
      .enum(ENTITY_TYPES)
      .describe(
        'What to summarize: user_hid (one of your accounts), device_id (one device), visitor_id (one browser visitor), ip (one IPv4 address) or cookie_id (one browser profile)',
      ),
    value: lookupValueSchema(
      'Identifier value: a UUID for device_id, visitor_id and cookie_id; a dotted IPv4 address such as 203.0.113.24 for ip; the exact User HID string for user_hid ("anonymous" summarizes anonymous checks; a User HID that contains "/" cannot be searched)',
    ),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(MAX_MAX_ITEMS)
      .default(DEFAULT_MAX_ITEMS)
      .describe(
        `Most recent identifications to analyze, from 1 to ${MAX_MAX_ITEMS} (default ${DEFAULT_MAX_ITEMS}). Each 100 identifications cost one History API request, from the domain's shared limit.`,
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

const OutputSchema = z.object({
  lookup: z.object({ type: z.enum(ENTITY_TYPES), value: z.string() }),
  computed_from: z.string(),
  window: z.object({
    identifications_analyzed: z.number().int(),
    total_matching: z.number().int(),
    max_items: z.number().int(),
    complete: z.boolean().describe('True when the window covers every matching identification'),
  }),
  summary: SummarySchema,
  untrusted_data_note: z.string(),
});

type SummaryOutput = z.infer<typeof OutputSchema>;

/** Reads up to `maxItems` identifications, newest first, skipping rows repeated across pages. */
export async function readWindow(
  client: ShieldLabs,
  type: (typeof ENTITY_TYPES)[number],
  value: string,
  maxItems: number,
  signal?: AbortSignal,
): Promise<{ items: IdentificationOutput[]; total: number }> {
  const items: IdentificationOutput[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let total = 0;
  // Enough pages for maxItems plus two spare pages for rows repeated across pages; never more.
  const maxPages = Math.ceil(maxItems / PAGE_SIZE) + 2;
  for (let pages = 0; pages < maxPages && items.length < maxItems; pages++) {
    const limit = Math.min(PAGE_SIZE, maxItems - items.length);
    const page = await client.history.search(type, value, { limit, offset, signal });
    total = page.total;
    if (page.data.length === 0) break;
    for (const identification of page.data) {
      if (identification.request_id !== '') {
        if (seen.has(identification.request_id)) continue;
        seen.add(identification.request_id);
      }
      items.push(toIdentificationOutput(identification));
      if (items.length >= maxItems) break;
    }
    offset += page.data.length;
    if (offset >= page.total) break;
  }
  return { items, total: Math.max(total, items.length) };
}

function dimensionLine(label: string, dimension: Summary['devices']): string {
  if (dimension.distinct === 0) return `- ${label}: none`;
  const top = dimension.top
    .map(
      (entry) =>
        `${code(entry.value)}${entry.truncated === true ? ' (shortened)' : ''} ${entry.count}`,
    )
    .join(', ');
  const more =
    dimension.distinct > dimension.top.length
      ? `, and ${dimension.distinct - dimension.top.length} more`
      : '';
  return `- ${label}: ${dimension.distinct} distinct (${top}${more})`;
}

function summaryMarkdown(output: SummaryOutput): string {
  const { lookup, window, summary } = output;
  const { risk } = summary;
  const lines = [`# Summary of ${lookup.type} ${code(lookup.value)}`, '', COMPUTED_FROM_NOTE, ''];
  if (window.identifications_analyzed === 0) {
    lines.push(
      `No identifications found for ${lookup.type} ${code(lookup.value)}, so there is nothing to summarize. The Private API Key reads one domain only.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `Window: the ${window.identifications_analyzed} most recent of ${window.total_matching} matching identifications (${window.complete ? 'complete' : `incomplete: raise max_items above ${window.max_items} to cover more`}), observed from ${formatTimestamp(summary.first_observed_at)} to ${formatTimestamp(summary.last_observed_at)}.`,
    '',
    '## Risk',
    `- Worst band: ${risk.worst_band ?? 'none (only rate-limit markers)'}`,
    `- Highest Risk Score: ${risk.max_risk_score ?? 'none'}; average: ${risk.average_risk_score ?? 'none'}`,
    `- Band counts: trusted ${risk.band_counts.trusted}, suspicious ${risk.band_counts.suspicious}, dangerous ${risk.band_counts.dangerous}`,
    `- Rate-limit markers (999, not a Risk Score): ${risk.rate_limit_markers}`,
    '',
    '## Identities and network',
    UNTRUSTED_DATA_NOTE,
    '',
    dimensionLine('Devices', summary.devices),
    dimensionLine('Accounts (User HIDs)', summary.users),
    dimensionLine('Visitors', summary.visitors),
    dimensionLine('Countries (public IP)', summary.countries),
    dimensionLine('Public IPs', summary.ips),
    dimensionLine('Connection types', summary.connection_types),
    `- Identifications without an account (null, anonymous or sentinel User HID): ${summary.identifications_without_account} (anonymous checks: ${summary.anonymous_identifications})`,
    `- Identifications without device signals (all-zero device ID): ${summary.identifications_without_device_signals}`,
    '',
    '## Detection flags seen',
  );
  if (summary.flags_seen.length === 0) lines.push('- none');
  for (const entry of summary.flags_seen) {
    lines.push(
      `- ${code(entry.flag)}: ${entry.count} of ${window.identifications_analyzed} identifications`,
    );
  }
  lines.push('', '## Risk signals seen');
  if (summary.signals_seen.length === 0) lines.push('- none');
  for (const entry of summary.signals_seen) {
    lines.push(
      `- ${code(entry.name)}: ${entry.count} identification${entry.count === 1 ? '' : 's'}`,
    );
  }
  const unlisted = summary.distinct_signals - summary.signals_seen.length;
  if (unlisted > 0) {
    lines.push(`- and ${unlisted} less frequent risk signal name${unlisted === 1 ? '' : 's'}`);
  }
  return lines.join('\n');
}

export function registerSummarizeEntity(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TOOL_NAMES.summarizeEntity,
    {
      title: 'Summarize user, device, visitor or IP',
      description: `Aggregate the recent History API identifications of one account (user_hid), device (device_id), browser visitor (visitor_id), IPv4 address (ip) or cookie (cookie_id).

The result is computed by this server from the returned history window (the most recent max_items identifications), and labelled as such: it is not a ShieldLabs verdict. It counts distinct devices, accounts, visitors, countries, IPs and connection types (with the top values), the highest and average Risk Score, band counts, rate-limit markers, detection flags and risk signals seen with counts, and the first and last observed time.

Use it for questions such as: how many accounts used this device, how many devices this account used, which countries an account came from, whether an IP sent automated traffic. Use shieldlabs_search_history to see the individual identifications.

Args:
  - type ('user_hid' | 'device_id' | 'visitor_id' | 'ip' | 'cookie_id')
  - value (string): UUID for the ID types, dotted IPv4 for ip, exact User HID for user_hid
  - max_items (number): 1-${MAX_MAX_ITEMS}, default ${DEFAULT_MAX_ITEMS}
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "lookup": { type, value }, "computed_from": string, "window": { identifications_analyzed, total_matching, max_items, complete }, "summary": { identifications_analyzed, first_observed_at, last_observed_at, devices: { distinct, top: [{ value, count, truncated? }] }, users, visitors, countries, ips, connection_types, anonymous_identifications, identifications_without_account, identifications_without_device_signals, risk: { max_risk_score, average_risk_score, worst_band, band_counts: { trusted, suspicious, dangerous }, rate_limit_markers }, flags_seen: [{ flag, count }], signals_seen: [{ name, count }], distinct_signals }, "untrusted_data_note": string }

The user count ignores values that do not name an account: null, "anonymous", "fail", "-1" and "unknown". The device count ignores the all-zero device ID (no usable device signals). Averages ignore the 999 rate-limit marker. The History API limit (about 15 requests per second per domain) is shared with the site's own backend: start with the default max_items and raise it only when the window is incomplete and the question needs older identifications.`,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: readOnlyAnnotations('Summarize user, device, visitor or IP', true),
    },
    async ({ type, value, max_items, response_format }, extra) => {
      try {
        checkLookupValue(type, value);
        const client = requireHistory(ctx);
        const { items, total } = await readWindow(client, type, value, max_items, extra.signal);
        const output: SummaryOutput = {
          lookup: {
            type,
            value: type === 'user_hid' || type === 'ip' ? value : value.toLowerCase(),
          },
          computed_from: COMPUTED_FROM_NOTE,
          window: {
            identifications_analyzed: items.length,
            total_matching: total,
            max_items,
            complete: items.length >= total,
          },
          summary: summarize(items),
          untrusted_data_note: UNTRUSTED_DATA_FIELD_NOTE,
        };
        return respond(ctx, output, summaryMarkdown(output), response_format, MARKDOWN_HINT);
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
