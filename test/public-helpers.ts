import { createHash, createHmac } from 'node:crypto';
import { vi } from 'vitest';
import type { PublicConfig } from '../src/public/config.js';
import { GATEWAY_HEADER } from '../src/public/gateway.js';
import type { PublicDependencies } from '../src/public/handler.js';
import type { PortalFetch } from '../src/public/portal.js';
import { TokenCache } from '../src/public/token.js';

export const PUBLIC_ORIGIN = 'https://mcp.example.test';
export const PORTAL_URL = 'https://account.example.test';
/** Different from the account API in the tests, to show which setting goes where. */
export const AUTH_ISSUER = 'https://auth.example.test';
export const GATEWAY_KEY = { kid: 'k1', secret: 'gateway-test-secret-0123456789abcdef' };
/** Fixed clock of the public-mode tests: 2026-10-01 12:00 UTC. */
export const NOW = Date.UTC(2026, 9, 1, 12);

export const TOKEN = `slat_${'A'.repeat(43)}`;
export const OTHER_TOKEN = `slat_${'C'.repeat(42)}-`;
export const CHALLENGE = `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`;

export const PUBLIC_CONFIG: PublicConfig = {
  publicOrigin: PUBLIC_ORIGIN,
  authIssuer: AUTH_ISSUER,
  portalUrl: PORTAL_URL,
  gatewayKey: GATEWAY_KEY,
};

export const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'public-test', version: '1' },
  },
};

export const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

export function toolCall(name: string, args?: Record<string, unknown>, id = 3) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: args === undefined ? { name } : { name, arguments: args },
  };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Checks an X-Shield-Gateway value the way the guard of the MCP prefix does, with node:crypto
 * and nothing from the code under test. Returns the refusal reason, or undefined when valid; a
 * valid nonce is recorded in `seen`.
 */
export function verifyGateway(
  header: string | undefined,
  request: { method: string; requestUri: string; token: string; nowMs: number; seen: Set<string> },
): string | undefined {
  if (header === undefined || header.trim() === '') return 'gateway_missing';
  const fields = header.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] !== 'v1') return 'gateway_malformed';
  const values = new Map(fields.slice(1).map((field) => field.split('=', 2) as [string, string]));
  const kid = values.get('kid');
  const t = Number(values.get('t'));
  const n = values.get('n') ?? '';
  const sig = values.get('sig') ?? '';
  if (kid === undefined || !Number.isInteger(t) || !/^[A-Za-z0-9_-]{16,64}$/.test(n)) {
    return 'gateway_malformed';
  }
  if (kid !== GATEWAY_KEY.kid) return 'gateway_unknown_key';
  if (Math.abs(Math.floor(request.nowMs / 1000) - t) > 60) return 'gateway_stale';
  const message = ['v1', t, n, request.method, request.requestUri, sha256(request.token)].join(
    '\n',
  );
  const expected = createHmac('sha256', GATEWAY_KEY.secret).update(message).digest('base64url');
  if (sig !== expected) return 'gateway_signature';
  if (request.seen.has(`${kid}:${n}`)) return 'gateway_replayed';
  request.seen.add(`${kid}:${n}`);
  return undefined;
}

export interface PortalCall {
  url: string;
  init: Parameters<PortalFetch>[1];
}

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * A fake ShieldLabs account API with the guard of the MCP prefix: GET /mcp/v1/ping answers 200
 * for a live token with a valid signature (signed within 60 seconds of `now`, nonce never seen),
 * and the documented 401 and 503 answers otherwise.
 */
export function fakePortal(options: { tokens?: string[]; now?: () => number } = {}) {
  const live = new Set(options.tokens ?? [TOKEN]);
  const now = options.now ?? (() => NOW);
  const seen = new Set<string>();
  const calls: PortalCall[] = [];
  let down = false;
  const fetch = vi.fn(async (url: string, init: PortalCall['init']) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    if (parsed.origin !== PORTAL_URL || parsed.pathname !== '/mcp/v1/ping') {
      return reply(404, { error: 'not found' });
    }
    const token = init.headers.Authorization?.replace(/^Bearer /, '') ?? '';
    const invalid = () =>
      reply(
        401,
        { error: 'invalid_token' },
        { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
      );
    if (!/^slat_[A-Za-z0-9_-]{43}$/.test(token)) return invalid();
    const reason = verifyGateway(init.headers[GATEWAY_HEADER], {
      method: init.method,
      requestUri: `${parsed.pathname}${parsed.search}`,
      token,
      nowMs: now(),
      seen,
    });
    if (reason !== undefined) return reply(401, { error: 'invalid_gateway_signature', reason });
    if (down) return reply(503, { error: 'temporarily_unavailable' });
    if (!live.has(token)) return invalid();
    return reply(200, { status: 'ok' });
  });
  return {
    fetch: fetch as unknown as PortalFetch & typeof fetch,
    calls,
    revoke: (token: string) => live.delete(token),
    setDown: (value: boolean) => (down = value),
  };
}

/** A fetch that answers every request with one status and body. */
export function answerFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const calls: PortalCall[] = [];
  const fetch = vi.fn(async (url: string, init: PortalCall['init']) => {
    calls.push({ url, init });
    return new Response(body, { status, headers });
  });
  return { fetch: fetch as unknown as PortalFetch & typeof fetch, calls };
}

/** Dependencies of handlePublicRequest for tests: fake account API, fixed clock, log lines. */
export function publicDeps(
  fetch: PortalFetch,
  overrides: Partial<PublicDependencies> = {},
): PublicDependencies & { lines: string[]; cache: TokenCache } {
  const lines: string[] = [];
  return {
    cache: new TokenCache(),
    fetch,
    now: () => NOW,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

/** A request to the MCP endpoint with the headers of an MCP client. */
export function mcpRequest(
  body: unknown,
  headers: Record<string, string> = {},
  init: { method?: string; path?: string } = {},
): Request {
  const method = init.method ?? 'POST';
  return new Request(`${PUBLIC_ORIGIN}${init.path ?? '/mcp'}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

export function bearer(value: string): Record<string, string> {
  return { authorization: `Bearer ${value}` };
}
