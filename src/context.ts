import {
  ShieldLabs,
  ShieldLabsError,
  ShieldLabsManagement,
  ValidationError,
  type DomainProfile,
  type FetchLike,
} from '@shieldlabs-ai/node';
import { splitSecrets, type ServerConfig } from './config.js';
import {
  HISTORY_TOOL_NAMES,
  OFFLINE_TOOL_NAMES,
  TOOL_NAMES,
  WAIT_TIMEOUT_MS,
  type ToolName,
} from './constants.js';
import {
  budgetedHistoryFetch,
  DEFAULT_HISTORY_BUDGET,
  type HistoryBudget,
} from './history-fetch.js';

/** Response of a GuideFetch: `body` (a byte stream) lets the reader stop at a size limit. */
export interface GuideResponse {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** A fetch-compatible function used for the remote setup guide (the global fetch satisfies it). */
export type GuideFetch = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<GuideResponse>;

/** Optional overrides, used by tests and by embedders. */
export interface ContextDependencies {
  /** fetch used by the History and Management clients. Default: the global fetch. */
  apiFetch?: FetchLike;
  /** fetch used by the integrate_shieldlabs prompt. Default: the global fetch. */
  guideFetch?: GuideFetch;
  /** Clock in epoch milliseconds. */
  now?: () => number;
  /** Retries of the API clients (default 2, as in @shieldlabs-ai/node). */
  maxRetries?: number;
  /** How long shieldlabs_get_identification polls for a verdict. Default 10 000 ms. */
  waitTimeoutMs?: number;
  /** History API requests of the whole process. Default: 2 in flight, 5 per second. */
  historyBudget?: HistoryBudget;
}

export interface CachedValue<T> {
  value: T;
  fetchedAt: number;
}

/** A request in progress that concurrent tool calls share. */
export interface SharedRequest<T> {
  promise: Promise<T>;
  /** Tool calls waiting for it. When the last one is cancelled, the request is aborted. */
  waiters: number;
  controller: AbortController;
}

/**
 * State shared by every MCP server instance of one process: configuration, API clients and
 * small caches. Over HTTP a fresh McpServer is created per request, so caches live here.
 */
export interface ServerContext {
  config: ServerConfig;
  history: ShieldLabs | undefined;
  management: ShieldLabsManagement | undefined;
  /** Tools this process exposes, after availability and the --tools allowlist. */
  enabledTools: ReadonlySet<ToolName>;
  /** Tools listed in --tools that cannot run with the current configuration. */
  unavailableRequestedTools: ToolName[];
  profileCache: CachedValue<DomainProfile> | undefined;
  /** The Management API profile request in progress, shared by concurrent calls. */
  profileRequest: SharedRequest<DomainProfile> | undefined;
  /** After a Management API 429: epoch ms until which the API is not called again. */
  profileBlockedUntil: number | undefined;
  guideCache: CachedValue<{ text: string; source: string }> | undefined;
  guideFetch: GuideFetch | undefined;
  now: () => number;
  waitTimeoutMs: number;
  /** Configured secret values, removed from any text the server returns. */
  secrets: string[];
}

/** Tools that can run with this configuration, ignoring the allowlist. */
export function availableTools(config: ServerConfig): ToolName[] {
  const tools: ToolName[] = [];
  if (config.apiKey !== undefined) tools.push(...HISTORY_TOOL_NAMES);
  tools.push(...OFFLINE_TOOL_NAMES);
  if (config.secretKey !== undefined && config.domain !== undefined) {
    tools.push(TOOL_NAMES.getDomainProfile);
  }
  return tools;
}

/** Runs a client constructor and names the settings to check when it rejects a value. */
function withSettings<T>(settings: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    if (error instanceof ShieldLabsError) {
      throw new ValidationError(`Check ${settings}: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/** Loopback host names as the URL parser writes them: localhost, *.localhost, 127.0.0.0/8, [::1]. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

/**
 * Refuses a plain http base URL outside loopback hosts: the key would travel unencrypted. Values
 * that are not URLs are left to the client, which names the problem.
 */
function requireHttps(name: string, value: string | undefined): void {
  if (value === undefined) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    throw new ValidationError(
      `${name} must be an https URL, such as the default ${name === 'SHIELDLABS_API_BASE_URL' ? 'https://account.shieldlabs.ai' : 'https://api.shieldlabs.ai'}: over plain http the key would travel unencrypted. Plain http is accepted only for localhost, 127.0.0.1 and [::1].`,
    );
  }
}

/** The global fetch, looked up at call time (a test can replace it). */
const globalApiFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/**
 * Builds the shared context. Throws the SDK's ValidationError, naming the environment variables to
 * check, when a configured value is unusable (for example SHIELDLABS_API_BASE_URL is not a URL).
 */
export function createContext(config: ServerConfig, deps: ContextDependencies = {}): ServerContext {
  const retries = deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {};

  const { apiKey, secretKey, domain } = config;
  let history: ShieldLabs | undefined;
  if (apiKey !== undefined) {
    requireHttps('SHIELDLABS_API_BASE_URL', config.apiBaseUrl);
    // Every History API request of the process goes through one budget, whatever tool sends it.
    const fetch = budgetedHistoryFetch(
      deps.apiFetch ?? globalApiFetch,
      deps.historyBudget ?? DEFAULT_HISTORY_BUDGET,
    );
    history = withSettings(
      'SHIELDLABS_API_KEY and SHIELDLABS_API_BASE_URL',
      () =>
        new ShieldLabs({
          apiKey,
          ...(config.apiBaseUrl !== undefined ? { baseUrl: config.apiBaseUrl } : {}),
          fetch,
          ...retries,
        }),
    );
  }

  let management: ShieldLabsManagement | undefined;
  if (secretKey !== undefined && domain !== undefined) {
    requireHttps('SHIELDLABS_MANAGEMENT_BASE_URL', config.managementBaseUrl);
    management = withSettings(
      'SHIELDLABS_SECRET_KEY, SHIELDLABS_DOMAIN and SHIELDLABS_MANAGEMENT_BASE_URL',
      () =>
        new ShieldLabsManagement({
          secretKey,
          domain,
          ...(config.managementBaseUrl !== undefined ? { baseUrl: config.managementBaseUrl } : {}),
          ...(deps.apiFetch !== undefined ? { fetch: deps.apiFetch } : {}),
          ...retries,
        }),
    );
  }

  const available = availableTools(config);
  const requested = config.tools;
  const enabled =
    requested === undefined ? available : available.filter((t) => requested.includes(t));
  const unavailableRequestedTools =
    requested === undefined ? [] : requested.filter((t) => !available.includes(t));

  const globalFetch = (globalThis as { fetch?: GuideFetch }).fetch;

  return {
    config,
    history,
    management,
    enabledTools: new Set(enabled),
    unavailableRequestedTools,
    profileCache: undefined,
    profileRequest: undefined,
    profileBlockedUntil: undefined,
    guideCache: undefined,
    guideFetch: deps.guideFetch ?? globalFetch,
    now: deps.now ?? Date.now,
    waitTimeoutMs: deps.waitTimeoutMs ?? WAIT_TIMEOUT_MS,
    secrets: [
      config.apiKey,
      config.secretKey,
      config.webhookSecret,
      ...splitSecrets(config.webhookSecret),
      config.mcpToken,
    ].filter((value): value is string => value !== undefined && value.length >= 4),
  };
}

/** Removes configured secrets and anything shaped like a ShieldLabs key from `text`. */
export function redact(ctx: Pick<ServerContext, 'secrets'>, text: string): string {
  let result = text;
  for (const secret of ctx.secrets) {
    result = result.split(secret).join('[redacted]');
  }
  return result
    .replace(/\bsec_[A-Za-z0-9]{8}-[A-Za-z0-9]{8}-[A-Za-z0-9]{8}\b/g, 'sec_[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_]{6,}/g, 'whsec_[redacted]');
}
