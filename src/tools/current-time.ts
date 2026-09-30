import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOOL_NAMES } from '../constants.js';
import type { ServerContext } from '../context.js';
import { ToolInputError } from '../errors.js';
import { failure, readOnlyAnnotations, respond, ResponseFormatSchema } from './shared.js';
import { nullableString } from '../schema.js';

const InputSchema = z
  .object({
    timezone: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'IANA time zone for an additional local time, for example "Europe/Berlin" or "America/New_York"',
      ),
    response_format: ResponseFormatSchema,
  })
  .strict();

const OutputSchema = z.object({
  utc: z.string().describe('Current time, RFC 3339 UTC with milliseconds'),
  unix_seconds: z.number().int(),
  unix_ms: z.number().int(),
  timezone: nullableString('The requested IANA time zone'),
  local_time: nullableString('Wall-clock time in the requested time zone, YYYY-MM-DD HH:MM:SS'),
  utc_offset: nullableString('Offset of the requested time zone, for example GMT+02:00'),
});

function localParts(date: Date, timeZone: string): { local: string; offset: string } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
  } catch {
    throw new ToolInputError(
      `unknown time zone "${timeZone}". Use an IANA name such as "UTC", "Europe/Berlin" or "America/New_York".`,
    );
  }
  const parts = Object.fromEntries(
    format.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName === 'GMT' ? 'GMT+00:00' : String(parts.timeZoneName);
  return {
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    offset,
  };
}

export function registerCurrentTime(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    TOOL_NAMES.currentTime,
    {
      title: 'Current time',
      description: `Return the current time of the machine running this server, in UTC and optionally in one IANA time zone.

Use it to judge freshness: for example whether an identification's observed_at is older than a 5-minute window, or how long ago an account was last seen.

Args:
  - timezone (string, optional): IANA time zone such as "Europe/Berlin"
  - response_format ('markdown' | 'json'): default 'markdown'

Returns (json): { "utc": string, "unix_seconds": number, "unix_ms": number, "timezone": string | null, "local_time": string | null, "utc_offset": string | null }`,
      inputSchema: InputSchema,
      outputSchema: OutputSchema,
      // Idempotent in the MCP sense: repeated calls have no effect on anything (the value changes).
      annotations: readOnlyAnnotations('Current time', false),
    },
    ({ timezone, response_format }) => {
      try {
        const now = new Date(ctx.now());
        const local = timezone === undefined ? undefined : localParts(now, timezone);
        const output = {
          utc: now.toISOString(),
          unix_seconds: Math.floor(now.getTime() / 1000),
          unix_ms: now.getTime(),
          timezone: timezone ?? null,
          local_time: local?.local ?? null,
          utc_offset: local?.offset ?? null,
        };
        const lines = [
          `Current time (UTC): ${output.utc}`,
          `Unix time: ${output.unix_seconds} s (${output.unix_ms} ms)`,
        ];
        if (local !== undefined)
          lines.push(`Local time in ${timezone}: ${local.local} (${local.offset})`);
        return respond(ctx, output, lines.join('\n'), response_format);
      } catch (error) {
        return failure(ctx, error);
      }
    },
  );
}
