import {
  ALL_TOOL_NAMES,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT,
  TOOL_NAMES,
  type ToolName,
} from './constants.js';

/** Invalid command-line usage. The message is shown to the user with a pointer to --help. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export type TransportKind = 'stdio' | 'http';

/** local: one configured key (default). public: hosted, multi-tenant; a token per request. */
export type ServerMode = 'local' | 'public';

/** Parsed command-line flags. */
export interface CliOptions {
  transport: TransportKind;
  port: number;
  host: string;
  allowedOrigins: string[];
  /** Tool allowlist, as full tool names. Undefined means every available tool. */
  tools: ToolName[] | undefined;
  /** Never fetch remote content (the integrate_shieldlabs prompt uses its built-in guide). */
  offline: boolean;
  /** Serving mode, when --mode is given. Absent means local. */
  mode?: ServerMode;
  /**
   * --mode public: take client addresses from CF-Connecting-IP, set by the proxy in front. Absent
   * means the address of the TCP connection.
   */
  trustProxy?: boolean;
  help: boolean;
  version: boolean;
}

/** ShieldLabs settings read from the environment. Empty values count as unset. */
export interface ShieldLabsSettings {
  apiKey: string | undefined;
  apiBaseUrl: string | undefined;
  secretKey: string | undefined;
  domain: string | undefined;
  managementBaseUrl: string | undefined;
  webhookSecret: string | undefined;
  mcpToken: string | undefined;
}

/** Everything the server needs to decide which tools, resources and prompts to expose. */
export interface ServerConfig extends ShieldLabsSettings {
  tools: ToolName[] | undefined;
  offline: boolean;
}

const VALUE_FLAGS = new Set([
  '--transport',
  '--mode',
  '--port',
  '--host',
  '--allowed-origins',
  '--tools',
]);
const BOOLEAN_FLAGS = new Set(['--offline', '--trust-proxy', '--help', '-h', '--version', '-v']);

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new UsageError(`--port must be an integer from 0 to 65535, got "${value}".`);
  }
  return Number(value);
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError(
      `--allowed-origins entries must be origins such as https://app.example.com, got "${value}".`,
    );
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin === 'null') {
    throw new UsageError(
      `--allowed-origins entries must be http or https origins, got "${value}".`,
    );
  }
  return url.origin;
}

/** Resolves a tool name given with or without the shieldlabs_ prefix. */
export function resolveToolName(value: string): ToolName {
  const name = value.startsWith('shieldlabs_') ? value : `shieldlabs_${value}`;
  const match = ALL_TOOL_NAMES.find((tool) => tool === name);
  if (match === undefined) {
    throw new UsageError(
      `Unknown tool "${value}" in --tools. Valid names: ${ALL_TOOL_NAMES.join(', ')}.`,
    );
  }
  return match;
}

/** Parses command-line arguments (without the node executable and script path). */
export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    transport: 'stdio',
    port: DEFAULT_HTTP_PORT,
    host: DEFAULT_HTTP_HOST,
    allowedOrigins: [],
    tools: undefined,
    offline: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    const equals = arg.indexOf('=');
    const flag = arg.startsWith('--') && equals > 0 ? arg.slice(0, equals) : arg;

    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag !== arg) throw new UsageError(`${flag} does not take a value.`);
      if (flag === '--offline') options.offline = true;
      else if (flag === '--trust-proxy') options.trustProxy = true;
      else if (flag === '--help' || flag === '-h') options.help = true;
      else options.version = true;
      continue;
    }

    if (!VALUE_FLAGS.has(flag)) {
      throw new UsageError(`Unknown option "${arg}".`);
    }

    let value: string;
    if (flag !== arg) {
      value = arg.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${flag} needs a value.`);
      }
      value = next;
      index++;
    }

    switch (flag) {
      case '--transport':
        if (value !== 'stdio' && value !== 'http') {
          throw new UsageError(`--transport must be "stdio" or "http", got "${value}".`);
        }
        options.transport = value;
        break;
      case '--mode':
        if (value !== 'local' && value !== 'public') {
          throw new UsageError(`--mode must be "local" or "public", got "${value}".`);
        }
        options.mode = value;
        break;
      case '--port':
        options.port = parsePort(value);
        break;
      case '--host':
        if (value.trim() === '') throw new UsageError('--host needs a value.');
        options.host = value.trim();
        break;
      case '--allowed-origins':
        options.allowedOrigins = splitList(value).map(parseOrigin);
        break;
      default: {
        const names = splitList(value).map(resolveToolName);
        if (names.length === 0) throw new UsageError('--tools needs at least one tool name.');
        options.tools = [...new Set(names)];
      }
    }
  }
  return options;
}

/**
 * The signing secrets in a value that holds one secret or several separated by commas (while an
 * endpoint's secret is being rotated), trimmed, without empty entries.
 */
export function splitSecrets(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret !== '');
}

function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Reads the ShieldLabs settings from environment variables. */
export function settingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ShieldLabsSettings {
  return {
    apiKey: envValue(env, 'SHIELDLABS_API_KEY'),
    apiBaseUrl: envValue(env, 'SHIELDLABS_API_BASE_URL'),
    secretKey: envValue(env, 'SHIELDLABS_SECRET_KEY'),
    domain: envValue(env, 'SHIELDLABS_DOMAIN'),
    managementBaseUrl: envValue(env, 'SHIELDLABS_MANAGEMENT_BASE_URL'),
    webhookSecret: envValue(env, 'SHIELDLABS_WEBHOOK_SECRET'),
    mcpToken: envValue(env, 'SHIELDLABS_MCP_TOKEN'),
  };
}

export function buildServerConfig(
  env: Readonly<Record<string, string | undefined>>,
  cli: Pick<CliOptions, 'tools' | 'offline'>,
): ServerConfig {
  return { ...settingsFromEnv(env), tools: cli.tools, offline: cli.offline };
}

export const HELP_TEXT = `Usage: shieldlabs-mcp [options]

MCP server for ShieldLabs: read identifications, search history, summarize users,
devices and IP addresses, explain Risk Scores and verify webhook signatures.
Local tools are read-only. Hosted mode also manages domains and webhooks.

Options:
  --transport <stdio|http>   Transport to serve (default: stdio)
  --mode <local|public>      local (default): the tools read with the configured keys.
                             public: the hosted multi-tenant server, every request
                             brings a ShieldLabs access token (needs --transport http)
  --port <number>            Port for --transport http (default: ${DEFAULT_HTTP_PORT})
  --host <address>           Bind address for --transport http (default: ${DEFAULT_HTTP_HOST})
  --allowed-origins <list>   Comma-separated browser origins allowed to call the HTTP
                             endpoint (default: none, requests with an Origin header are refused)
  --tools <list>             Local mode only: comma-separated allowlist of tools, with or
                             without the shieldlabs_ prefix (default: every available tool)
  --offline                  Never fetch remote content: the integrate_shieldlabs prompt
                             uses its built-in guide (always the case with --transport http)
  --trust-proxy              --mode public: rate limit per client address from the
                             CF-Connecting-IP header, which the proxy in front must set
                             (default: the address of the TCP connection)
  -h, --help                 Show this help and exit
  -v, --version              Show the version and exit

Environment:
  SHIELDLABS_API_KEY              Private API Key (sec_...) of one domain. Enables the
                                  History API tools; without it only offline tools run
  SHIELDLABS_SECRET_KEY           Secret Key of the domain (Management API, optional)
  SHIELDLABS_DOMAIN               Registered domain for the Management API, e.g. example.com
  SHIELDLABS_WEBHOOK_SECRET       Default signing secret (whsec_...) for
                                  ${TOOL_NAMES.verifyWebhookSignature}; several
                                  separated by commas while you rotate
  SHIELDLABS_API_BASE_URL         History API origin (default: https://account.shieldlabs.ai;
                                  plain http only for localhost, 127.0.0.1 and [::1])
  SHIELDLABS_MANAGEMENT_BASE_URL  Management API origin (default: https://api.shieldlabs.ai;
                                  plain http only for localhost, 127.0.0.1 and [::1])
  SHIELDLABS_MCP_TOKEN            Bearer token required by --transport http (generated and
                                  printed once to stderr when unset)

Environment of --mode public (the settings above are not used):
  SHIELDLABS_PUBLIC_ORIGIN        Origin clients connect to, e.g. https://mcp.shieldlabs.ai
  SHIELDLABS_PORTAL_URL           ShieldLabs account API that checks every access token,
                                  e.g. https://account.shieldlabs.ai
  SHIELDLABS_AUTH_ISSUER          OAuth authorization server (default: SHIELDLABS_PORTAL_URL)
  MCP_GATEWAY_KEY                 kid:secret that signs every request to the account API

Local tools (hosted tools are listed by MCP tools/list):
  ${ALL_TOOL_NAMES.join('\n  ')}

Docs: https://docs.shieldlabs.ai  Support: contact@shieldlabs.ai
`;
