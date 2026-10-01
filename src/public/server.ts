import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { z } from 'zod';
import { DOCS_URL, SERVER_NAME, SERVER_VERSION, SUPPORT_EMAIL } from '../constants.js';
import type { PingResult } from './portal.js';

/** The one tool of public mode in this release. */
export const CHECK_CONNECTION_TOOL = 'shieldlabs_check_connection';

/** Tools public mode registers. The identification tools stay with the local server for now. */
export const PUBLIC_TOOL_NAMES: readonly string[] = [CHECK_CONNECTION_TOOL];

const LATER_RELEASE =
  'Tools that read identifications arrive in a later release of the hosted server; until then, the local server (npx -y @shieldlabs-ai/mcp) reads them with the Private API Key of a domain.';

export const PUBLIC_INSTRUCTIONS = [
  'ShieldLabs identifies visitors and scores risk. This is the hosted ShieldLabs MCP server: the user signed in with a ShieldLabs account, and every request carries the access token of that sign-in.',
  `In this release it offers one tool, ${CHECK_CONNECTION_TOOL}, which confirms that the connection to the ShieldLabs account works. ${LATER_RELEASE}`,
  'All tools are read-only: nothing here changes data in ShieldLabs.',
].join('\n\n');

const OutputSchema = z.object({
  connected: z
    .boolean()
    .describe('True when ShieldLabs accepted the access token of this connection'),
  checked_at: z.string().describe('When the check ran, RFC 3339 UTC'),
});

/** The tool result for an answer of the ShieldLabs API. */
export function checkResult(result: PingResult, now: number): CallToolResult {
  switch (result.outcome) {
    case 'ok': {
      const output = { connected: true, checked_at: new Date(now).toISOString() };
      return {
        content: [
          {
            type: 'text',
            text: `The connection to ShieldLabs works: ShieldLabs accepted the access token of this connection (checked at ${output.checked_at}). ${LATER_RELEASE}`,
          },
        ],
        structuredContent: output,
      };
    }
    case 'invalid_token':
      return failure(
        'Error: ShieldLabs no longer accepts the access token of this connection: it expired or was revoked. Reconnect ShieldLabs in your MCP client (in Claude: Customize > Connectors) to sign in again; retrying will not help.',
      );
    case 'unavailable':
      return failure(
        'Error: ShieldLabs is temporarily unavailable or did not answer in time. Retry in a few seconds.',
      );
    default:
      return failure(
        `Error: the hosted ShieldLabs server could not check the connection because of a problem on the server side, not of this connection. Retry later; if it persists, contact ${SUPPORT_EMAIL}.`,
      );
  }
}

function failure(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export interface PublicServerOptions {
  /** Pings the ShieldLabs API with the access token of this request, without the cache. */
  checkConnection: () => Promise<PingResult>;
  /** Clock in epoch milliseconds. */
  now: () => number;
  /**
   * JSON Schema validator of the SDK server. Default: a new Ajv instance, which compiles schemas
   * to code; Workers forbid that, so the Worker passes CfWorkerJsonSchemaValidator.
   */
  jsonSchemaValidator?: jsonSchemaValidator;
}

/**
 * The MCP server of one public-mode request: the instructions and shieldlabs_check_connection,
 * with no prompts or resources (they need the identification tools). Cheap: one per request.
 */
export function createPublicServer({
  checkConnection,
  now,
  jsonSchemaValidator,
}: PublicServerOptions): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'ShieldLabs',
      version: SERVER_VERSION,
      websiteUrl: DOCS_URL,
      description: 'Hosted ShieldLabs MCP server: connect a ShieldLabs account by signing in.',
    },
    {
      instructions: PUBLIC_INSTRUCTIONS,
      ...(jsonSchemaValidator === undefined ? {} : { jsonSchemaValidator }),
    },
  );
  server.registerTool(
    CHECK_CONNECTION_TOOL,
    {
      title: 'Check the ShieldLabs connection',
      description: `Check that this connection to the hosted ShieldLabs server works: ShieldLabs checks the access token the user signed in with. Takes no input.

Use it to confirm the sign-in, or when another call fails with an authentication error.

Returns (json): { "connected": boolean, "checked_at": string }

Errors: an expired or revoked sign-in asks the user to reconnect ShieldLabs in the MCP client; a temporary outage asks to retry in a few seconds.

${LATER_RELEASE}`,
      // No input schema: the tool takes no arguments, and a call that omits them is valid.
      outputSchema: OutputSchema,
      annotations: {
        title: 'Check the ShieldLabs connection',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => checkResult(await checkConnection(), now()),
  );
  return server;
}
