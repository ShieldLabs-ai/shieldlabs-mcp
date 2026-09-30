import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DOCS_URL, SERVER_NAME, SERVER_VERSION } from './constants.js';
import type { ServerContext } from './context.js';
import { buildInstructions } from './instructions.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import { registerTools } from './tools/index.js';

/** Creates one MCP server with every enabled tool, resource and prompt. Cheap: create one per HTTP request. */
export function createShieldLabsServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'ShieldLabs',
      version: SERVER_VERSION,
      websiteUrl: DOCS_URL,
      description:
        'Read ShieldLabs identifications, search history, summarize users, devices and IP addresses, explain Risk Scores and verify webhook signatures.',
    },
    { instructions: buildInstructions(ctx) },
  );
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}
