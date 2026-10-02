import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CHARACTER_LIMIT, LOOKUP_TYPES, TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import { ToolInputError } from '../errors.js';
import { code, UNTRUSTED_DATA_FIELD_NOTE, UNTRUSTED_DATA_NOTE } from '../format.js';
import {
  IdentificationOutputSchema,
  identificationMarkdown,
  toIdentificationOutput,
  type IdentificationOutput,
} from '../identification.js';
import {
  failure,
  MARKDOWN_HINT,
  readOnlyAnnotations,
  requireHistory,
  respond,
  ResponseFormatSchema,
  toJsonText,
} from './shared.js';

export const LookupTypeSchema = z
  .enum(LOOKUP_TYPES)
  .describe(
    'Identifier to search by: request_id (one identification), user_hid (one of your accounts, exact and case-sensitive), device_id (one device), visitor_id (one browser visitor), ip (IPv4 only), session_id (one visit) or cookie_id (one browser profile)',
  );

/** An identifier value with the shared bounds, described for the lookup types a tool accepts. */
export function lookupValueSchema(description: string) {
  return z
    .string()
    .min(1, 'value must not be empty')
    .max(512, 'value must be at most 512 characters')
    .describe(description);
}

export const LookupValueSchema = lookupValueSchema(
  'Identifier value: a UUID for request_id, device_id, visitor_id, session_id and cookie_id; a dotted IPv4 address such as 203.0.113.24 for ip; the exact User HID string for user_hid ("anonymous" lists anonymous checks; a User HID that contains "/" cannot be searched)',
);

/**
 * Refuses, before any request, a User HID with "/", with a next step for the investigation: the
 * History API cannot search such a value, so the lookup would look empty even when
 * identifications exist. The History client refuses the other values a URL path segment cannot
 * carry ("." and "..", text that is not valid Unicode) and escapes the rest the way the History
 * API matches it.
 */
export function checkLookupValue(type: string, value: string): void {
  if (type === 'user_hid' && value.includes('/')) {
    throw new ToolInputError(
      'user_hid values that contain "/" cannot be searched: the History API cannot match them, so the lookup would look empty even when identifications exist. Look the account up another way, for example by the device_id or visitor_id of one of its identifications.',
    );
  }
}

const InputSchema = z
  .object({
    type: LookupTypeSchema,
    value: LookupValueSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Identifications per page, from 1 to 100 (default 20)'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(10_000_000)
      .default(0)
      .describe(
        'Number of identifications to skip, for paging (default 0). Use next_offset from the previous page.',
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

export const OutputSchema = z.object({
  lookup: z.object({ type: z.enum(LOOKUP_TYPES), value: z.string() }),
  total: z.number().int().describe('Identifications matching the lookup'),
  count: z.number().int().describe('Identifications in this response'),
  offset: z.number().int(),
  limit: z.number().int(),
  has_more: z.boolean(),
  next_offset: z.number().int().optional(),
  identifications: z.array(IdentificationOutputSchema),
  untrusted_data_note: z.string(),
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
});

type SearchOutput = z.infer<typeof OutputSchema>;

function searchMarkdown(output: SearchOutput): string {
  const { lookup, total, count, offset } = output;
  const lines = [`# History for ${lookup.type} ${code(lookup.value)}`, ''];
  if (count === 0) {
    lines.push(
      total > 0
        ? `No identifications at offset ${offset}: the lookup matches ${total}. Use a smaller offset.`
        : `No identifications found for ${lookup.type} ${code(lookup.value)}. The Private API Key reads one domain only${lookup.type === 'user_hid' ? ', and User HID matching is exact and case-sensitive' : ''}.`,
    );
    return lines.join('\n');
  }
  lines.push(
    `Showing ${count} of ${total} identifications (offset ${offset}), newest first.${output.has_more ? ` More are available: next_offset=${output.next_offset}.` : ''}`,
  );
  if (output.truncated === true && output.truncation_message !== undefined) {
    lines.push('', `Note: ${output.truncation_message}`);
  }
  lines.push('', UNTRUSTED_DATA_NOTE, '');
  output.identifications.forEach((item, index) => {
    lines.push(...identificationMarkdown(item, `## ${offset + index + 1}.`), '');
  });
  return lines.join('\n').trimEnd();
}

/**
 * Builds the page output, dropping identifications from the end until both renderings (the
 * markdown text and the JSON of the structured content) fit the character limit, whatever format
 * was asked for. Paging metadata always describes what is returned.
 */
export function buildSearchOutput(
  lookup: SearchOutput['lookup'],
  items: IdentificationOutput[],
  total: number,
  offset: number,
  limit: number,
): { output: SearchOutput; markdown: string } {
  let shown = items;
  for (;;) {
    const hasMore = offset + shown.length < total;
    const output: SearchOutput = {
      lookup,
      total,
      count: shown.length,
      offset,
      limit,
      has_more: hasMore,
      ...(hasMore ? { next_offset: offset + shown.length } : {}),
      identifications: shown,
      untrusted_data_note: UNTRUSTED_DATA_FIELD_NOTE,
    };
    if (shown.length < items.length) {
      output.truncated = true;
      output.truncation_message = `Response truncated from ${items.length} to ${shown.length} identifications to stay under ${CHARACTER_LIMIT.toLocaleString('en-US')} characters. Continue with offset=${offset + shown.length}, or use a smaller limit.`;
    }
    const markdown = searchMarkdown(output);
    const size = Math.max(markdown.length, toJsonText(output).length);
    if (size <= CHARACTER_LIMIT || shown.length <= 1) return { output, markdown };
    // Shrink in proportion to the overshoot (with a margin for the paging notice), at least by one.
    const target = Math.floor((shown.length * CHARACTER_LIMIT * 0.95) / size);
    shown = shown.slice(0, Math.max(1, Math.min(shown.length - 1, target)));
  }
}

export function registerSearchHistory(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TOOL_NAMES.searchHistory,
    {
      title: 'Search history',
      description: `List identifications for one identifier from the ShieldLabs History API, newest first, with paging.

Use it to see individual identifications of an account (user_hid), a device (device_id), a browser visitor (visitor_id), a cookie (cookie_id), a visit (session_id) or an IPv4 address (ip). For counts and aggregates over many identifications, prefer shieldlabs_summarize_entity.

Args:
  - type ('request_id' | 'user_hid' | 'device_id' | 'visitor_id' | 'ip' | 'session_id' | 'cookie_id')
  - value (string): UUID for the ID types, dotted IPv4 for ip, exact User HID for user_hid
  - limit (number): 1-100, default 20
  - offset (number): default 0
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "lookup": { type, value }, "total": number, "count": number, "offset": number, "limit": number, "has_more": boolean, "next_offset": number (only when has_more), "identifications": [same shape as shieldlabs_get_identification], "untrusted_data_note": string, "truncated"?: boolean, "truncation_message"?: string }

Examples:
  - Every identification of one account: type="user_hid", value="<User HID>"
  - Which accounts used this device: type="device_id", value="<device ID>"
  - Next page: repeat with offset=next_offset

Errors: invalid values are refused before any request (UUID or IPv4 expected; IPv6 is not searchable; a User HID that contains "/" cannot be searched). 401 means a wrong key; 429 means the History API rate limit (about 15 requests per second per domain) was reached.`,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      annotations: readOnlyAnnotations('Search history', true),
    },
    async ({ type, value, limit, offset, response_format }, extra) => {
      try {
        checkLookupValue(type, value);
        const client = requireHistory(ctx);
        const page = await client.history.search(type, value, {
          limit,
          offset,
          signal: extra.signal,
        });
        const lookupValue = type === 'user_hid' || type === 'ip' ? value : value.toLowerCase();
        const { output, markdown } = buildSearchOutput(
          { type, value: lookupValue },
          page.data.map(toIdentificationOutput),
          page.total,
          offset,
          limit,
        );
        return respond(
          ctx,
          output,
          markdown,
          response_format,
          output.count <= 1 ? MARKDOWN_HINT : 'Use a smaller limit.',
        );
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
