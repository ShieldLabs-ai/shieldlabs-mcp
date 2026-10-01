import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ShieldLabs } from '@shieldlabs-ai/node';
import { z } from 'zod';
import { UUID_PATTERN } from '../constants.js';
import { redact, type ServerContext } from '../context.js';
import { describeError, ToolInputError, type ApiSurface } from '../errors.js';
import { DEFAULT_SHRINK_HINT, enforceCharacterLimit, enforceJsonLimit } from '../format.js';

export const ResponseFormatSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe("Output format: 'markdown' (default) for readable text, 'json' for structured data");

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const RequestIdSchema = z
  .string()
  .regex(UUID_PATTERN, 'request_id must be a UUID such as a5b7c9d1-e3f5-4a7b-9c1d-3e5f7a9b1c3d')
  .describe(
    'Request ID of one identification: the UUID the browser agent returned for the protected action, for example "a5b7c9d1-e3f5-4a7b-9c1d-3e5f7a9b1c3d"',
  );

/** Tool annotations shared by every tool: all are read-only and repeatable. */
export function readOnlyAnnotations(title: string, openWorld: boolean) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: openWorld,
  } as const;
}

/** What an oversized json response asks for when the data cannot be split further. */
export const MARKDOWN_HINT =
  'Ask again with response_format "markdown", which shortens long values.';

/** Compact JSON: the json response format is meant for programs and costs half the tokens of indented JSON. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * A successful result: markdown or compact JSON as text, and the same data as structuredContent.
 * Every tool bounds its own data so that both stay within the character limit (lists are
 * shortened, long values are cut and flagged). As a last resort, oversized markdown is cut with a
 * notice and oversized JSON is replaced by a small valid document; `shrinkHint` says what to ask
 * for instead.
 */
export function respond(
  ctx: Pick<ServerContext, 'secrets'>,
  structured: Record<string, unknown>,
  markdown: string,
  format: ResponseFormat,
  shrinkHint = DEFAULT_SHRINK_HINT,
): CallToolResult {
  const text =
    format === 'json'
      ? enforceJsonLimit(redact(ctx, toJsonText(structured)), shrinkHint)
      : enforceCharacterLimit(redact(ctx, markdown), shrinkHint);
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
}

/** An error result with an actionable, secret-free message. */
export function failure(
  ctx: Pick<ServerContext, 'secrets'>,
  error: unknown,
  surface: ApiSurface = 'history',
): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: enforceCharacterLimit(describeError(ctx, error, surface)) }],
  };
}

/** The History client, or a ToolInputError explaining how to configure it. */
export function requireHistory(ctx: ServerContext): ShieldLabs {
  if (ctx.history === undefined) {
    throw new ToolInputError(
      'SHIELDLABS_API_KEY is not set, so the History API cannot be read. Set it to the Private API Key (sec_...) of the domain in the MCP client configuration and restart the server.',
    );
  }
  return ctx.history;
}
