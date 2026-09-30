/** Package name reported in serverInfo. */
export const SERVER_NAME = 'shieldlabs-mcp';
/** Version of this server. Kept in sync with package.json (a test checks it). */
export const SERVER_VERSION = '1.0.0';

export const DOCS_URL = 'https://docs.shieldlabs.ai';
export const APP_URL = 'https://app.shieldlabs.ai';
export const SUPPORT_EMAIL = 'contact@shieldlabs.ai';

/** Upper bound for the text of one tool response. Longer responses are shortened with a notice. */
export const CHARACTER_LIMIT = 25_000;

/** How long shieldlabs_get_identification waits for a verdict by default. */
export const WAIT_TIMEOUT_MS = 10_000;

/** When a new identification can be read, in the words every tool and message uses. */
export const HISTORY_TIMING =
  'Scoring is asynchronous: the History row appears about 1 to 3 seconds after the browser call and can be refined for up to about 10 seconds while follow-up checks finish.';

/** How to get the final version of a verdict that may still be refined. */
export const REFINEMENT_ADVICE =
  'A verdict read in those first seconds can still be refined: read it again (wait=false is enough) once observed_at is about 10 seconds in the past for the final state.';

/** The domain profile is cached this long: the Management API allows about 15 calls per minute per IP. */
export const PROFILE_CACHE_MS = 60_000;

/**
 * Setup skill fetched by the integrate_shieldlabs prompt (stdio only), pinned to the skills
 * release this server version was tested with: later commits to the skills repository never
 * reach installed servers.
 */
export const SETUP_SKILL_REF = 'refs/tags/v1.0.0';
export const SETUP_SKILL_URL = `https://raw.githubusercontent.com/ShieldLabs-ai/shieldlabs-skills/${SETUP_SKILL_REF}/skills/shieldlabs-setup/SKILL.md`;
export const SETUP_SKILL_TIMEOUT_MS = 3_000;
export const SETUP_SKILL_CACHE_MS = 60 * 60 * 1000;
/** Larger bodies are not read to the end: the built-in guide is used instead. */
export const SETUP_SKILL_MAX_BYTES = 200_000;

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8787;
export const MCP_HTTP_PATH = '/mcp';
export const HEALTH_PATH = '/health';
export const MAX_HTTP_BODY_BYTES = 1_000_000;

/** Tool names. Every tool is read-only and prefixed with shieldlabs_. */
export const TOOL_NAMES = {
  getIdentification: 'shieldlabs_get_identification',
  searchHistory: 'shieldlabs_search_history',
  summarizeEntity: 'shieldlabs_summarize_entity',
  explainRiskScore: 'shieldlabs_explain_risk_score',
  getDomainProfile: 'shieldlabs_get_domain_profile',
  verifyWebhookSignature: 'shieldlabs_verify_webhook_signature',
  currentTime: 'shieldlabs_current_time',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const ALL_TOOL_NAMES: readonly ToolName[] = Object.values(TOOL_NAMES);

/** Tools that never call a ShieldLabs API. They are available without any key. */
export const OFFLINE_TOOL_NAMES: readonly ToolName[] = [
  TOOL_NAMES.explainRiskScore,
  TOOL_NAMES.verifyWebhookSignature,
  TOOL_NAMES.currentTime,
];

/** Tools that read the History API and need SHIELDLABS_API_KEY. */
export const HISTORY_TOOL_NAMES: readonly ToolName[] = [
  TOOL_NAMES.getIdentification,
  TOOL_NAMES.searchHistory,
  TOOL_NAMES.summarizeEntity,
];

/** Identifier types the History API can search by. */
export const LOOKUP_TYPES = [
  'request_id',
  'user_hid',
  'device_id',
  'visitor_id',
  'ip',
  'session_id',
  'cookie_id',
] as const;

/** Identifier types that shieldlabs_summarize_entity aggregates. */
export const ENTITY_TYPES = ['user_hid', 'device_id', 'visitor_id', 'ip', 'cookie_id'] as const;

/** User HID values that do not name an account: anonymous checks and agent sentinels. */
export const NON_ACCOUNT_USER_HIDS: ReadonlySet<string> = new Set([
  'anonymous',
  'fail',
  '-1',
  'unknown',
]);

export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
