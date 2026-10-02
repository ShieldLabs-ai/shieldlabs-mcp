import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../../src/constants.js';
import { gatewayHeader } from '../../src/public/gateway.js';
import { sha256Hex } from '../../src/public/digest.js';
import { CHECK_CONNECTION_TOOL } from '../../src/public/server.js';

// The Worker runs with the dev settings of wrangler.jsonc, except the account API origin and the
// gateway key (vitest.worker.config.ts).
const ORIGIN = 'https://dev.mcp.shieldlabs.ai';
const MCP_URL = `${ORIGIN}/mcp`;
const PORTAL = 'https://account.example.test';
const SECRET = 'gateway-test-secret-0123456789abcdef';
const TOKEN = `slat_${'A'.repeat(43)}`;
const CHALLENGE = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`;

interface UpstreamCall {
  url: string;
  headers: Headers;
}

let upstream: UpstreamCall[];
let live: Set<string>;
let seen: Set<string>;

/**
 * Installs a fake account API as the global fetch, which the Worker shares with the tests: it
 * answers GET /mcp/v1/ping and checks the signature, its time window and its nonce the way the
 * guard of the MCP prefix does.
 */
function installFakeAccountApi(): void {
  upstream = [];
  live = new Set([TOKEN]);
  seen = new Set();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    upstream.push({ url: request.url, headers: request.headers });
    if (url.origin !== PORTAL || url.pathname !== '/mcp/v1/ping') {
      return new Response('unexpected request', { status: 599 });
    }
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const sent = request.headers.get('x-shield-gateway') ?? '';
    const t = Number(sent.match(/ t=(\d+) /)?.[1]);
    const n = sent.match(/ n=(\S+) /)?.[1] ?? '';
    const expected = await gatewayHeader(
      { kid: 'k1', secret: SECRET },
      {
        method: request.method,
        requestUri: `${url.pathname}${url.search}`,
        tokenHash: await sha256Hex(token),
        unixSeconds: t,
        nonce: n,
      },
    );
    const fresh = Math.abs(t - Math.floor(Date.now() / 1000)) <= 60;
    if (sent !== expected || !fresh || seen.has(n)) {
      return Response.json(
        { error: 'invalid_gateway_signature', reason: 'gateway_signature' },
        { status: 401 },
      );
    }
    seen.add(n);
    if (!live.has(token)) return Response.json({ error: 'invalid_token' }, { status: 401 });
    return Response.json({ status: 'ok' });
  });
}

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(body: unknown, token = TOKEN): Promise<any> {
  const response = await post(body, { authorization: `Bearer ${token}` });
  expect(response.status).toBe(200);
  return response.json();
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'worker-test', version: '1' },
  },
};

/**
 * Runs a rate limit check until a run falls within one minute of the wall clock: the rate limiting
 * bindings of the tests count in windows aligned to the minute, so a run that spans two windows
 * proves nothing. Every run has client addresses of its own.
 */
async function withinOneWindow(
  check: (address: (host: number) => string) => Promise<void>,
): Promise<void> {
  for (let run = 0; ; run++) {
    const window = Math.floor(Date.now() / 60_000);
    upstream = [];
    try {
      await check((host) => `198.18.${run}.${host}`);
      return;
    } catch (error) {
      if (run === 2 || Math.floor(Date.now() / 60_000) === window) throw error;
    }
  }
}

beforeEach(() => {
  installFakeAccountApi();
});

describe('the Worker', () => {
  it('answers /health with 200 and the version, without calling the account API', async () => {
    const response = await SELF.fetch(`${ORIGIN}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: SERVER_VERSION });
    expect(upstream).toHaveLength(0);
  });

  it('answers an unauthenticated /mcp request with the exact 401 challenge', async () => {
    const response = await post(INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(upstream).toHaveLength(0);
  });

  it('serves the protected resource metadata of Development at both paths', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(await response.text()).toBe(
        JSON.stringify({
          resource: `${ORIGIN}/mcp`,
          authorization_servers: ['https://dev.account.shieldlabs.ai'],
          bearer_methods_supported: ['header'],
          resource_name: 'ShieldLabs',
          resource_documentation: 'https://docs.shieldlabs.ai',
        }),
      );
    }
  });

  it('runs initialize, tools/list and the check tool with signed pings', async () => {
    const init = await rpc(INITIALIZE);
    expect(init.result.serverInfo).toMatchObject({
      name: 'shieldlabs-mcp',
      version: SERVER_VERSION,
    });
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      CHECK_CONNECTION_TOOL,
    );
    expect(listed.result.tools).toHaveLength(21);
    const checked = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: CHECK_CONNECTION_TOOL, arguments: {} },
    });
    expect(checked.result.isError).toBeUndefined();
    expect(checked.result.structuredContent.connected).toBe(true);
    // One ping for the three requests (then cached), one for the tool, each with its own nonce.
    expect(upstream.map((call) => new URL(call.url).pathname)).toEqual([
      '/mcp/v1/ping',
      '/mcp/v1/ping',
    ]);
    expect(seen.size).toBe(2);
  });

  it('refuses API keys without calling the account API, and revoked tokens after a ping', async () => {
    const key = await post(INITIALIZE, { authorization: 'Bearer sec_abcd1234-efgh5678-ijkl9012' });
    expect(key.status).toBe(401);
    expect(key.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token"`);
    expect(upstream).toHaveLength(0);
    const revoked = await post(INITIALIZE, { authorization: `Bearer slat_${'Z'.repeat(43)}` });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toBe(`${CHALLENGE}, error="invalid_token"`);
    expect(upstream).toHaveLength(1);
  });

  it('limits requests without a token per address with the rate limiting binding', async () => {
    await withinOneWindow(async (address) => {
      const statuses: number[] = [];
      for (let i = 0; i < 61; i++) {
        statuses.push((await post(INITIALIZE, { 'cf-connecting-ip': address(1) })).status);
      }
      expect(statuses.slice(0, 60).every((status) => status === 401)).toBe(true);
      expect(statuses[60]).toBe(429);
      expect((await post(INITIALIZE, { 'cf-connecting-ip': address(2) })).status).toBe(401);
    });
  });

  it('pings for at most 300 new tokens per minute and address', async () => {
    await withinOneWindow(async (address) => {
      const from = (index: number) => ({
        'cf-connecting-ip': address(1),
        authorization: `Bearer slat_${String(index).padStart(43, 'q')}`,
      });
      for (let index = 0; index < 300; index++) await post(INITIALIZE, from(index));
      expect(upstream).toHaveLength(300);
      const refused = await post(INITIALIZE, from(300));
      expect(refused.status).toBe(429);
      expect(upstream).toHaveLength(300);
    });
  });
});
