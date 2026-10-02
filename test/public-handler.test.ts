import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../src/constants.js';
import { publicConfigFromEnv } from '../src/public/config.js';
import { GATEWAY_HEADER } from '../src/public/gateway.js';
import {
  handlePublicRequest,
  redactSecrets,
  type PublicDependencies,
} from '../src/public/handler.js';
import { memoryRateLimiter } from '../src/public/rate-limit.js';
import { CHECK_CONNECTION_TOOL } from '../src/public/server.js';
import {
  answerFetch,
  AUTH_ISSUER,
  bearer,
  CHALLENGE,
  fakePortal,
  GATEWAY_KEY,
  INITIALIZE,
  mcpRequest,
  NOW,
  OTHER_TOKEN,
  PUBLIC_CONFIG,
  PUBLIC_ORIGIN,
  publicDeps,
  sha256,
  TOKEN,
  toolCall,
  TOOLS_LIST,
} from './public-helpers.js';

const INVALID_TOKEN_CHALLENGE = `${CHALLENGE}, error="invalid_token"`;

function handle(request: Request, deps: PublicDependencies, config = PUBLIC_CONFIG) {
  return handlePublicRequest(request, config, deps);
}

/** Connects the SDK client to the handler through a fetch that calls it directly. */
async function connectClient(token: string, deps: PublicDependencies): Promise<Client> {
  const client = new Client({ name: 'public-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_ORIGIN}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => handle(new Request(url, init), deps),
  });
  await client.connect(transport as never);
  return client;
}

async function rpc(token: string, body: unknown, deps: PublicDependencies): Promise<any> {
  const response = await handle(mcpRequest(body, bearer(token)), deps);
  expect(response.status).toBe(200);
  return response.json();
}

describe('public mode: discovery', () => {
  it('answers /health without authentication or a call to the ShieldLabs API', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    const health = await handle(new Request(`${PUBLIC_ORIGIN}/health`), deps);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', version: SERVER_VERSION });
    const head = await handle(new Request(`${PUBLIC_ORIGIN}/health`, { method: 'HEAD' }), deps);
    expect(head.status).toBe(200);
    const post = await handle(new Request(`${PUBLIC_ORIGIN}/health`, { method: 'POST' }), deps);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect(portal.calls).toHaveLength(0);
  });

  it('serves the protected resource metadata at both paths, without scopes', async () => {
    const deps = publicDeps(fakePortal().fetch);
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await handle(new Request(`${PUBLIC_ORIGIN}${path}`), deps);
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await response.text()).toBe(
        JSON.stringify({
          resource: `${PUBLIC_ORIGIN}/mcp`,
          authorization_servers: [AUTH_ISSUER],
          bearer_methods_supported: ['header'],
          resource_name: 'ShieldLabs',
          resource_documentation: 'https://docs.shieldlabs.ai',
        }),
      );
      const preflight = await handle(
        new Request(`${PUBLIC_ORIGIN}${path}`, {
          method: 'OPTIONS',
          headers: { origin: 'http://localhost:6274' },
        }),
        deps,
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        'mcp-protocol-version',
      );
      const post = await handle(new Request(`${PUBLIC_ORIGIN}${path}`, { method: 'POST' }), deps);
      expect(post.status).toBe(405);
    }
  });

  it('publishes the documented metadata and challenge with the dev settings', async () => {
    const config = publicConfigFromEnv({
      SHIELDLABS_PUBLIC_ORIGIN: 'https://dev.mcp.shieldlabs.ai',
      SHIELDLABS_AUTH_ISSUER: 'https://dev.account.shieldlabs.ai',
      SHIELDLABS_PORTAL_URL: 'https://dev.account.shieldlabs.ai',
      MCP_GATEWAY_KEY: `${GATEWAY_KEY.kid}:${GATEWAY_KEY.secret}`,
    });
    const deps = publicDeps(fakePortal().fetch);
    const metadata = await handle(
      new Request('https://dev.mcp.shieldlabs.ai/.well-known/oauth-protected-resource/mcp'),
      deps,
      config,
    );
    expect(await metadata.json()).toEqual({
      resource: 'https://dev.mcp.shieldlabs.ai/mcp',
      authorization_servers: ['https://dev.account.shieldlabs.ai'],
      bearer_methods_supported: ['header'],
      resource_name: 'ShieldLabs',
      resource_documentation: 'https://docs.shieldlabs.ai',
    });
    const unauthenticated = await handle(mcpRequest(INITIALIZE), deps, config);
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://dev.mcp.shieldlabs.ai/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('answers 404 for other paths', async () => {
    const deps = publicDeps(fakePortal().fetch);
    expect((await handle(new Request(`${PUBLIC_ORIGIN}/sse`), deps)).status).toBe(404);
  });
});

describe('public mode: authentication', () => {
  it('answers a request without a token with the sign-in challenge, before any call', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    for (const headers of [
      {},
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: 'Bearer' },
    ]) {
      const response = await handle(mcpRequest(INITIALIZE, headers), deps);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect(portal.calls).toHaveLength(0);
  });

  it('refuses API keys and other credentials as invalid tokens, never sending them anywhere', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    for (const value of [
      'sec_abcd1234-efgh5678-ijkl9012',
      `slk_${'B'.repeat(43)}`,
      `slrt_${'A'.repeat(43)}`,
      'eyJhbGciOiJIUzI1NiJ9.e30.x',
      'slat_short',
      `slat_${'A'.repeat(44)}`,
      `${TOKEN} ${OTHER_TOKEN}`,
    ]) {
      const response = await handle(mcpRequest(INITIALIZE, bearer(value)), deps);
      expect(response.status, value).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(INVALID_TOKEN_CHALLENGE);
      const body: any = await response.json();
      expect(body.error).toBe('invalid_token');
      expect(body.error_description).toContain('API keys are not accepted by this server yet');
    }
    expect(portal.calls).toHaveLength(0);
  });

  it('never names a scope in a challenge or a body', async () => {
    const deps = publicDeps(fakePortal().fetch);
    for (const request of [mcpRequest(INITIALIZE), mcpRequest(INITIALIZE, bearer(OTHER_TOKEN))]) {
      const response = await handle(request, deps);
      expect(response.headers.get('www-authenticate')).not.toContain('scope');
      expect(await response.text()).not.toContain('scope');
    }
  });

  it('checks a token with a signed ping and serves later requests from the cache for 60 s', async () => {
    let now = NOW;
    const portal = fakePortal({ now: () => now });
    const deps = publicDeps(portal.fetch, { now: () => now });
    expect((await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps)).status).toBe(200);
    expect((await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps)).status).toBe(200);
    expect(portal.calls).toHaveLength(1);
    expect(deps.cache.size).toBe(1);
    now += 59_000;
    expect((await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps)).status).toBe(200);
    expect(portal.calls).toHaveLength(1);
    now += 1_000;
    expect((await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps)).status).toBe(200);
    expect(portal.calls).toHaveLength(2);
    const [ping] = portal.calls;
    expect(ping!.url).toBe('https://account.example.test/mcp/v1/ping');
    expect(ping!.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(ping!.init.headers[GATEWAY_HEADER]).toMatch(/^v1 kid=k1 t=\d+ n=\S{22} sig=\S{43}$/);
    expect(JSON.parse(deps.lines[1]!).check).toBe('cached');
  });

  it('answers a token the ShieldLabs API refuses with the challenge, and never caches it', async () => {
    const portal = fakePortal({ tokens: [TOKEN] });
    const deps = publicDeps(portal.fetch);
    for (let i = 0; i < 2; i++) {
      const response = await handle(mcpRequest(INITIALIZE, bearer(OTHER_TOKEN)), deps);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(INVALID_TOKEN_CHALLENGE);
    }
    expect(portal.calls).toHaveLength(2);
    expect(deps.cache.size).toBe(0);
  });

  it('answers 503 when the ShieldLabs API is down or unreachable, without caching', async () => {
    const portal = fakePortal();
    portal.setDown(true);
    const cases: [PublicDependencies['fetch'], string][] = [
      [portal.fetch, 'unavailable'],
      [answerFetch(502, 'Bad gateway').fetch, 'unavailable'],
      [vi.fn(() => Promise.reject(new TypeError('connect ECONNREFUSED'))), 'unavailable'],
    ];
    for (const [fetch, check] of cases) {
      const deps = publicDeps(fetch!);
      const response = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps);
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(await response.json()).toMatchObject({ error: 'temporarily_unavailable' });
      expect(JSON.parse(deps.lines[0]!).check).toBe(check);
      expect(deps.cache.size).toBe(0);
    }
  });

  it('answers 500 and logs the cause when the API refuses the signature of this server', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    const wrongKey = {
      ...PUBLIC_CONFIG,
      gatewayKey: { kid: 'k1', secret: `x${GATEWAY_KEY.secret}` },
    };
    const response = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps, wrongKey);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
    const line = JSON.parse(deps.lines[0]!);
    expect(line).toMatchObject({
      status: 500,
      check: 'gateway_signature',
      error: 'GatewaySignatureRejected',
    });
    expect(line.message).toContain('MCP_GATEWAY_KEY');
    for (const secret of [TOKEN, GATEWAY_KEY.secret, 'sig=']) {
      expect(deps.lines.join('\n')).not.toContain(secret);
    }
    expect(deps.cache.size).toBe(0);
  });

  it('answers 500 for an answer the MCP prefix never gives, such as a 404', async () => {
    const deps = publicDeps(answerFetch(404, 'not found').fetch);
    const response = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps);
    expect(response.status).toBe(500);
    expect(JSON.parse(deps.lines[0]!)).toMatchObject({
      check: 'unexpected_404',
      error: 'UnexpectedApiAnswer',
    });
    expect(JSON.parse(deps.lines[0]!).message).toContain('SHIELDLABS_PORTAL_URL');
  });

  it('answers 405 to other methods once the token is accepted', async () => {
    const deps = publicDeps(fakePortal().fetch);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const response = await handle(mcpRequest(undefined, bearer(TOKEN), { method }), deps);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST, OPTIONS');
    }
    expect((await handle(mcpRequest(undefined, {}, { method: 'GET' }), deps)).status).toBe(401);
  });
});

describe('public mode: MCP requests', () => {
  it('offers hosted operations, prompts and resources', async () => {
    const deps = publicDeps(fakePortal().fetch);
    const client = await connectClient(TOKEN, deps);
    expect(client.getServerVersion()).toMatchObject({
      name: 'shieldlabs-mcp',
      title: 'ShieldLabs',
      version: SERVER_VERSION,
    });
    const capabilities = client.getServerCapabilities()!;
    expect(capabilities.tools).toBeDefined();
    expect(capabilities.prompts).toBeDefined();
    expect(capabilities.resources).toBeDefined();
    expect(client.getInstructions()).toContain(CHECK_CONNECTION_TOOL);
    expect(client.getInstructions()).not.toContain('SHIELDLABS_');
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(21);
    expect(tools[0]).toMatchObject({
      name: CHECK_CONNECTION_TOOL,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
    expect(tools[0]!.outputSchema?.required).toEqual(['connected', 'checked_at']);
    await client.close();
  });

  it('runs shieldlabs_check_connection with a fresh ping, with or without arguments', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    const client = await connectClient(TOKEN, deps);
    const pingsBefore = portal.calls.length;
    const result = (await client.callTool({ name: CHECK_CONNECTION_TOOL, arguments: {} })) as any;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      connected: true,
      checked_at: new Date(NOW).toISOString(),
    });
    expect(result.content[0].text).toContain('The connection to ShieldLabs works');
    expect(result.content[0].text).toContain('shieldlabs_list_domains');
    expect(portal.calls.length).toBe(pingsBefore + 1);
    await client.close();

    const bare = await rpc(TOKEN, toolCall(CHECK_CONNECTION_TOOL), deps);
    expect(bare.result.structuredContent.connected).toBe(true);
    expect(portal.calls.length).toBe(pingsBefore + 2);
  });

  it('asks to reconnect when the token was revoked since it was cached', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    expect((await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps)).status).toBe(200);
    expect(deps.cache.size).toBe(1);
    portal.revoke(TOKEN);
    const body = await rpc(TOKEN, toolCall(CHECK_CONNECTION_TOOL, {}), deps);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Reconnect ShieldLabs in your MCP client');
    expect(deps.cache.size).toBe(0);
    const next = await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps);
    expect(next.status).toBe(401);
    expect(next.headers.get('www-authenticate')).toBe(INVALID_TOKEN_CHALLENGE);
  });

  it('reports an outage or a server-side problem from the tool, and logs the latter', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    await handle(mcpRequest(TOOLS_LIST, bearer(TOKEN)), deps);
    portal.setDown(true);
    const down = await rpc(TOKEN, toolCall(CHECK_CONNECTION_TOOL, {}), deps);
    expect(down.result.isError).toBe(true);
    expect(down.result.content[0].text).toContain('temporarily unavailable');
    expect(deps.cache.size).toBe(1);

    const refusing = publicDeps(
      answerFetch(401, '{"error":"invalid_gateway_signature","reason":"gateway_unknown_key"}')
        .fetch,
    );
    refusing.cache.remember(sha256(TOKEN), NOW);
    const refused = await rpc(TOKEN, toolCall(CHECK_CONNECTION_TOOL, {}), refusing);
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain('problem on the server side');
    expect(JSON.parse(refusing.lines[0]!)).toMatchObject({
      tool: CHECK_CONNECTION_TOOL,
      check: 'cached',
      error: 'GatewaySignatureRejected',
    });
    expect(JSON.parse(refusing.lines[0]!).message).toContain('gateway_unknown_key');
  });

  it('keeps the requests of two tokens apart', async () => {
    const portal = fakePortal({ tokens: [TOKEN, OTHER_TOKEN] });
    const deps = publicDeps(portal.fetch);
    await Promise.all([
      rpc(TOKEN, toolCall(CHECK_CONNECTION_TOOL, {}, 1), deps),
      rpc(OTHER_TOKEN, toolCall(CHECK_CONNECTION_TOOL, {}, 2), deps),
    ]);
    const sent = portal.calls.map((call) => call.init.headers.Authorization).sort();
    expect(sent).toEqual(
      [
        `Bearer ${TOKEN}`,
        `Bearer ${TOKEN}`,
        `Bearer ${OTHER_TOKEN}`,
        `Bearer ${OTHER_TOKEN}`,
      ].sort(),
    );
    expect(deps.cache.size).toBe(2);
  });

  it('limits bodies to 1 MB and answers invalid JSON with a parse error', async () => {
    const deps = publicDeps(fakePortal().fetch);
    const huge = await handle(mcpRequest(`{"x":"${'a'.repeat(1_100_000)}"}`, bearer(TOKEN)), deps);
    expect(huge.status).toBe(413);
    const declared = await handle(
      mcpRequest('{}', { ...bearer(TOKEN), 'content-length': '2000000' }),
      deps,
    );
    expect(declared.status).toBe(413);
    const invalid = await handle(mcpRequest('{not json', bearer(TOKEN)), deps);
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).error.code).toBe(-32700);
  });

  it('refuses JSON-RPC batches before any tool runs', async () => {
    const spy = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest');
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    const batch = [1, 2, 3].map((id) => toolCall(CHECK_CONNECTION_TOOL, {}, id));
    const response = await handle(mcpRequest(batch, bearer(TOKEN)), deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message:
          'Invalid Request: batches are not supported. Send one JSON-RPC message per request.',
      },
      id: null,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(portal.calls).toHaveLength(1);
    expect(JSON.parse(deps.lines[0]!)).toMatchObject({ rpc: 'batch', status: 400 });
  });
});

describe('public mode: CORS and Origin', () => {
  it('answers preflights for https and local origins and refuses the others with 403', async () => {
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch);
    for (const origin of [
      'https://claude.ai',
      'http://localhost:6274',
      'http://127.0.0.1:3000',
      'http://[::1]:8080',
    ]) {
      const response = await handle(mcpRequest(undefined, { origin }, { method: 'OPTIONS' }), deps);
      expect(response.status, origin).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
      expect(response.headers.get('access-control-allow-headers')).toBe(
        'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id',
      );
      expect(response.headers.get('access-control-max-age')).toBe('600');
    }
    for (const origin of [
      'null',
      'file://',
      'http://evil.example',
      'chrome-extension://abc',
      'x',
    ]) {
      const response = await handle(mcpRequest(INITIALIZE, { ...bearer(TOKEN), origin }), deps);
      expect(response.status, origin).toBe(403);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000 },
      });
    }
    expect(portal.calls).toHaveLength(0);
  });

  it('lets browser clients read the challenge and the responses', async () => {
    const deps = publicDeps(fakePortal().fetch);
    const origin = 'https://inspector.example';
    const challenge = await handle(mcpRequest(INITIALIZE, { origin }), deps);
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('access-control-allow-origin')).toBe(origin);
    expect(challenge.headers.get('access-control-expose-headers')).toBe(
      'www-authenticate, mcp-protocol-version',
    );
    const ok = await handle(mcpRequest(INITIALIZE, { ...bearer(TOKEN), origin }), deps);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(origin);
    const plain = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps);
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('public mode: rate limits', () => {
  it('limits requests per token, keyed by its hash', async () => {
    const token = { limit: vi.fn(async () => ({ success: false })) };
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch, { rateLimiters: { token } });
    const response = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(token.limit).toHaveBeenCalledWith({ key: `t:${sha256(TOKEN)}` });
    expect(portal.calls).toHaveLength(0);
  });

  it('limits refused requests per address, except the shared egress network', async () => {
    const anon = memoryRateLimiter(2, 60_000, () => NOW);
    const deps = publicDeps(fakePortal().fetch, { rateLimiters: { anon } });
    const from = (ip: string, headers: Record<string, string> = {}) =>
      handle(mcpRequest(INITIALIZE, { 'cf-connecting-ip': ip, ...headers }), deps);
    expect((await from('192.0.2.1')).status).toBe(401);
    expect((await from('192.0.2.1', bearer('sec_abc'))).status).toBe(401);
    expect((await from('192.0.2.1', bearer(OTHER_TOKEN))).status).toBe(429);
    expect((await from('192.0.2.1')).status).toBe(429);
    expect((await from('192.0.2.2')).status).toBe(401);
    for (let i = 0; i < 5; i++) expect((await from('160.79.106.9')).status).toBe(401);
    // An accepted token is limited per token only.
    expect((await from('192.0.2.1', bearer(TOKEN))).status).toBe(200);
  });

  it('limits pings for new tokens per address before asking the ShieldLabs API', async () => {
    const tokenCheck = memoryRateLimiter(3, 60_000, () => NOW);
    const portal = fakePortal();
    const deps = publicDeps(portal.fetch, { rateLimiters: { tokenCheck } });
    const from = (ip: string, token: string) =>
      handle(mcpRequest(INITIALIZE, { 'cf-connecting-ip': ip, ...bearer(token) }), deps);
    const unknown = (char: string) => `slat_${char.repeat(43)}`;
    expect((await from('192.0.2.1', TOKEN)).status).toBe(200);
    expect((await from('192.0.2.1', unknown('x'))).status).toBe(401);
    expect((await from('192.0.2.1', unknown('y'))).status).toBe(401);
    expect(portal.calls).toHaveLength(3);
    for (const char of ['z', 'w']) {
      const refused = await from('192.0.2.1', unknown(char));
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('60');
    }
    expect(portal.calls).toHaveLength(3);
    // Cached tokens, other addresses and the shared egress network are not limited.
    expect((await from('192.0.2.1', TOKEN)).status).toBe(200);
    for (const char of ['1', '2', '3', '4']) {
      expect((await from('160.79.104.20', unknown(char))).status).toBe(401);
    }
    expect(portal.calls).toHaveLength(7);
  });
});

describe('public mode: logging', () => {
  it('logs one line per request without tokens, signatures or bodies', async () => {
    const deps = publicDeps(fakePortal().fetch);
    const response = await handle(
      mcpRequest(toolCall(CHECK_CONNECTION_TOOL, { note: 'private text' }), {
        ...bearer(TOKEN),
        'cf-ray': '8c1f0e2d3a4b5c6d-AMS',
      }),
      deps,
    );
    expect(response.status).toBe(200);
    await handle(mcpRequest(INITIALIZE, bearer(`slat_${'x'.repeat(10)}`)), deps);
    await handle(new Request(`${PUBLIC_ORIGIN}/private/path?token=${TOKEN}`), deps);
    expect(deps.lines).toHaveLength(3);
    const [call, rejected, other] = deps.lines.map((line) => JSON.parse(line));
    expect(call).toEqual({
      ts: new Date(NOW).toISOString(),
      rid: '8c1f0e2d3a4b5c6d-AMS',
      route: '/mcp',
      rpc: 'tools/call',
      tool: CHECK_CONNECTION_TOOL,
      status: 200,
      ms: 0,
      token: sha256(TOKEN).slice(0, 8),
      check: 'ok',
    });
    expect(rejected).toMatchObject({ route: '/mcp', status: 401 });
    expect(rejected.rid).toMatch(/^[0-9a-f-]{36}$/);
    expect(rejected.token).toBeUndefined();
    expect(other).toMatchObject({ route: 'other', status: 404 });
    const text = deps.lines.join('\n');
    for (const secret of [TOKEN, 'slat_xxxx', 'private text', 'v1 kid=', GATEWAY_KEY.secret]) {
      expect(text).not.toContain(secret);
    }
  });

  it('logs unexpected errors by class with a redacted message', async () => {
    const deps = publicDeps(fakePortal().fetch);
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValue(
      new TypeError(`boom with ${TOKEN}, ${OTHER_TOKEN} and ${GATEWAY_KEY.secret}`),
    );
    const response = await handle(mcpRequest(INITIALIZE, bearer(TOKEN)), deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: -32603 } });
    const line = JSON.parse(deps.lines[0]!);
    expect(line).toMatchObject({ status: 500, error: 'TypeError' });
    expect(line.message).toBe('boom with [redacted], slat_[redacted] and [redacted]');
    expect(redactSecrets(`refresh slrt_${'Q'.repeat(43)}`, [])).toBe('refresh slrt_[redacted]');
  });
});
