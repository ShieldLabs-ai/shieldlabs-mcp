import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_NAMES, type ToolName } from '../constants.js';
import type { ServerContext } from '../context.js';
import { registerCurrentTime } from './current-time.js';
import { registerGetDomainProfile } from './domain-profile.js';
import { registerExplainRiskScore } from './explain-risk-score.js';
import { registerGetIdentification } from './get-identification.js';
import { registerSearchHistory } from './search-history.js';
import { registerSummarizeEntity } from './summarize-entity.js';
import { registerVerifyWebhookSignature } from './verify-webhook.js';

const REGISTRARS: Record<ToolName, (server: McpServer, ctx: ServerContext) => void> = {
  [TOOL_NAMES.getIdentification]: registerGetIdentification,
  [TOOL_NAMES.searchHistory]: registerSearchHistory,
  [TOOL_NAMES.summarizeEntity]: registerSummarizeEntity,
  [TOOL_NAMES.explainRiskScore]: registerExplainRiskScore,
  [TOOL_NAMES.getDomainProfile]: registerGetDomainProfile,
  [TOOL_NAMES.verifyWebhookSignature]: registerVerifyWebhookSignature,
  [TOOL_NAMES.currentTime]: registerCurrentTime,
};

/** Registers every enabled tool, in a stable order. */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  for (const [name, register] of Object.entries(REGISTRARS) as [
    ToolName,
    typeof registerCurrentTime,
  ][]) {
    if (ctx.enabledTools.has(name)) register(server, ctx);
  }
}
