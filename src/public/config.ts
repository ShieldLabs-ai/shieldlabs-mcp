import type { GatewayKey } from './gateway.js';

/** Unusable public-mode settings. The message names the variable to fix and never quotes a secret. */
export class PublicConfigError extends Error {
  override name = 'PublicConfigError';
}

/** The ShieldLabs API refuses shorter gateway secrets. */
export const MIN_GATEWAY_SECRET_BYTES = 32;

/** Public-mode settings: Worker variables and secrets, or the environment of the Node.js server. */
export interface PublicEnv {
  SHIELDLABS_PUBLIC_ORIGIN?: string | undefined;
  SHIELDLABS_AUTH_ISSUER?: string | undefined;
  SHIELDLABS_PORTAL_URL?: string | undefined;
  MCP_GATEWAY_KEY?: string | undefined;
}

export interface PublicConfig {
  /** Origin that clients connect to. The MCP endpoint is its /mcp path, the token audience. */
  publicOrigin: string;
  /** Authorization server named in the protected resource metadata. Default: portalUrl. */
  authIssuer: string;
  /** Origin of the ShieldLabs account API whose MCP prefix checks every access token. */
  portalUrl: string;
  /** Key of the X-Shield-Gateway signature on every request to the MCP prefix. */
  gatewayKey: GatewayKey;
}

/** Hosts on which public mode accepts plain http: local development only. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function read(env: PublicEnv, name: keyof PublicEnv): string | undefined {
  const value: unknown = env[name];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The origin of an https URL, or of an http URL on a loopback host (local development). Paths
 * are refused: every setting here names a whole site.
 */
export function originSetting(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicConfigError(
      `${name} must be an absolute URL such as https://example.com, got "${value}".`,
    );
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new PublicConfigError(
      `${name} must be an https URL (plain http only for localhost, 127.0.0.1 and [::1]), got "${value}".`,
    );
  }
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new PublicConfigError(
      `${name} must be an origin without a path, such as https://example.com, got "${value}".`,
    );
  }
  return url.origin;
}

function requiredOrigin(env: PublicEnv, name: keyof PublicEnv, example: string): string {
  const value = read(env, name);
  if (value === undefined) {
    throw new PublicConfigError(`${name} is not set: set it to an origin such as ${example}.`);
  }
  return originSetting(name, value);
}

/**
 * The gateway key of a "kid:secret" value, with the rules the ShieldLabs API applies to its
 * MCP_GATEWAY_KEYS entries. Messages never quote the value: it holds the secret.
 */
export function parseGatewayKey(value: string | undefined): GatewayKey {
  if (value === undefined) {
    throw new PublicConfigError(
      'MCP_GATEWAY_KEY is not set: set it to kid:secret, the key the ShieldLabs API lists for this server in MCP_GATEWAY_KEYS (on Workers: npx wrangler secret put MCP_GATEWAY_KEY --env <environment>).',
    );
  }
  const separator = value.indexOf(':');
  const kid = separator === -1 ? '' : value.slice(0, separator);
  const secret = separator === -1 ? '' : value.slice(separator + 1);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(kid)) {
    throw new PublicConfigError(
      'MCP_GATEWAY_KEY must look like kid:secret, with a key ID of 1 to 32 letters, digits, ".", "_" or "-".',
    );
  }
  if (new TextEncoder().encode(secret).length < MIN_GATEWAY_SECRET_BYTES || /[\s,]/.test(secret)) {
    throw new PublicConfigError(
      `The secret in MCP_GATEWAY_KEY must have at least ${MIN_GATEWAY_SECRET_BYTES} bytes and no spaces or commas, like the entries of MCP_GATEWAY_KEYS in the ShieldLabs API.`,
    );
  }
  return { kid, secret };
}

/**
 * Reads and checks the public-mode settings. Throws PublicConfigError naming the variable to fix.
 * The origins have no defaults, so that a server for one environment never falls back to the
 * account API or the audience of another.
 */
export function publicConfigFromEnv(env: PublicEnv): PublicConfig {
  const publicOrigin = requiredOrigin(env, 'SHIELDLABS_PUBLIC_ORIGIN', 'https://mcp.shieldlabs.ai');
  const portalUrl = requiredOrigin(env, 'SHIELDLABS_PORTAL_URL', 'https://account.shieldlabs.ai');
  const issuer = read(env, 'SHIELDLABS_AUTH_ISSUER');
  return {
    publicOrigin,
    authIssuer: issuer === undefined ? portalUrl : originSetting('SHIELDLABS_AUTH_ISSUER', issuer),
    portalUrl,
    gatewayKey: parseGatewayKey(read(env, 'MCP_GATEWAY_KEY')),
  };
}
