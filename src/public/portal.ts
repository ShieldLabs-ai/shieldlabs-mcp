import { SERVER_VERSION } from '../constants.js';
import type { PublicConfig } from './config.js';
import { GATEWAY_HEADER, gatewayHeader, newNonce, requestUriOf } from './gateway.js';
import type { TokenCache } from './token.js';

/** The probe route of the MCP prefix: 200 {"status":"ok"} for a live token with a valid signature. */
export const PING_PATH = '/mcp/v1/ping';

/** How long the ShieldLabs API has to answer a ping. There are no retries. */
export const PING_TIMEOUT_MS = 3_000;

/** The part of a fetch response a ping reads. */
export interface PortalResponse {
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** A fetch for the ShieldLabs API (the global fetch satisfies it). */
export type PortalFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'manual';
  },
) => Promise<PortalResponse>;

/**
 * The answer of the MCP prefix, as this server acts on it:
 * - ok: the token is live and the signature valid;
 * - invalid_token: the token is unknown, expired or revoked (the client must sign in again);
 * - gateway_rejected: the API refused the signature of this server (a misconfiguration here);
 * - unavailable: the API is down, slow or failing (503, any 5xx, network errors, the timeout);
 * - unexpected: any other answer, such as a 404 from a wrong SHIELDLABS_PORTAL_URL.
 */
export type PingResult =
  | { outcome: 'ok' }
  | { outcome: 'invalid_token' }
  | { outcome: 'gateway_rejected'; reason: string }
  | { outcome: 'unavailable'; status?: number }
  | { outcome: 'unexpected'; status: number };

export interface PingDependencies {
  config: PublicConfig;
  fetch: PortalFetch;
  /** Clock in epoch milliseconds, for the signature time. */
  now: () => number;
  /** Nonce generator, for tests. Default: 16 random bytes. */
  nonce?: () => string;
}

function errorOf(text: string): { error?: unknown; reason?: unknown } {
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    return {};
  }
}

/** A refusal reason of the ShieldLabs API, kept only when it cannot carry text into a log. */
function safeReason(reason: unknown): string {
  return typeof reason === 'string' && /^gateway_[a-z_]{1,40}$/.test(reason)
    ? reason
    : 'gateway_unknown';
}

function classify(status: number, text: string): PingResult {
  if (status === 200) {
    return (errorOf(text) as { status?: unknown }).status === 'ok'
      ? { outcome: 'ok' }
      : { outcome: 'unexpected', status };
  }
  if (status === 401) {
    const { error, reason } = errorOf(text);
    if (error === 'invalid_token') return { outcome: 'invalid_token' };
    if (error === 'invalid_gateway_signature') {
      return { outcome: 'gateway_rejected', reason: safeReason(reason) };
    }
    return { outcome: 'unexpected', status };
  }
  if (status >= 500) return { outcome: 'unavailable', status };
  return { outcome: 'unexpected', status };
}

/**
 * GET /mcp/v1/ping with the token and a fresh signature: one attempt with a 3-second timeout,
 * redirects not followed. `tokenHash` is the lowercase hex SHA-256 of `token`.
 */
export async function pingPortal(
  token: string,
  tokenHash: string,
  { config, fetch, now, nonce = newNonce }: PingDependencies,
): Promise<PingResult> {
  const url = `${config.portalUrl}${PING_PATH}`;
  const signature = await gatewayHeader(config.gatewayKey, {
    method: 'GET',
    requestUri: requestUriOf(url),
    tokenHash,
    unixSeconds: Math.floor(now() / 1000),
    nonce: nonce(),
  });
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'User-Agent': `shieldlabs-mcp/${SERVER_VERSION}`,
    [GATEWAY_HEADER]: signature,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      redirect: 'manual',
    });
    return classify(response.status, await response.text());
  } catch {
    return { outcome: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/** throttled: `mayPing` refused to ask the ShieldLabs API about a token that is not cached. */
export type TokenCheck =
  | { outcome: 'ok'; cached: boolean }
  | Exclude<PingResult, { outcome: 'ok' }>
  | { outcome: 'throttled' };

/**
 * Checks a token: from the cache, else with a ping. Only an accepted token is cached, for at most
 * the cache's TTL; `mayPing` runs before each ping, never for a cached token.
 */
export async function checkToken(
  token: string,
  tokenHash: string,
  cache: TokenCache,
  deps: PingDependencies,
  mayPing: () => Promise<boolean> = () => Promise.resolve(true),
): Promise<TokenCheck> {
  if (cache.has(tokenHash, deps.now())) return { outcome: 'ok', cached: true };
  if (!(await mayPing())) return { outcome: 'throttled' };
  const result = await pingPortal(token, tokenHash, deps);
  if (result.outcome !== 'ok') return result;
  cache.remember(tokenHash, deps.now());
  return { outcome: 'ok', cached: false };
}
