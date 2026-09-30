import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServerConfig } from '../src/config.js';
import { TOOL_NAMES } from '../src/constants.js';
import { createContext } from '../src/context.js';
import {
  generateToken,
  isAuthorized,
  isLoopbackHost,
  startHttpServer,
  type RunningHttpServer,
} from '../src/http.js';
import { createShieldLabsServer } from '../src/server.js';
import { FULL_ENV, mockApiFetch } from './helpers.js';

const TOKEN = 'test-token-0123456789';
const ALLOWED_ORIGIN = 'https://console.example.com';
let running: RunningHttpServer;
const log = vi.fn();

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'curl', version: '1' },
  },
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(running.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Sends a request with an arbitrary Host header (fetch does not allow overriding it). */
function rawRequest(host: string): Promise<number> {
  const url = new URL(running.url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host,
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(INITIALIZE));
  });
}

beforeAll(async () => {
  const ctx = createContext(buildServerConfig(FULL_ENV, { tools: undefined, offline: true }), {
    apiFetch: mockApiFetch().fetch,
    maxRetries: 0,
  });
  running = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    allowedOrigins: [ALLOWED_ORIGIN],
    createMcpServer: () => createShieldLabsServer(ctx),
    log,
  });
});

afterAll(async () => {
  await running.close();
});

describe('streamable HTTP transport', () => {
  it('answers /health without authentication and without data', async () => {
    const response = await fetch(running.url.replace('/mcp', '/health'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    const head = await fetch(running.url.replace('/mcp', '/health'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    const wrongMethod = await fetch(running.url.replace('/mcp', '/health'), { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
  });

  it('returns 404 for unknown paths', async () => {
    const response = await fetch(running.url.replace('/mcp', '/other'));
    expect(response.status).toBe(404);
  });

  it('refuses requests without a valid bearer token with 401', async () => {
    const missing = await post(INITIALIZE);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    const wrong = await post(INITIALIZE, { authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    const scheme = await post(INITIALIZE, { authorization: `Basic ${TOKEN}` });
    expect(scheme.status).toBe(401);
  });

  it('answers initialize with 200 when the token is right', async () => {
    const response = await post(INITIALIZE, { authorization: `Bearer ${TOKEN}` });
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.result.serverInfo).toMatchObject({ name: 'shieldlabs-mcp', version: '1.0.0' });
    expect(body.result.instructions).toContain('trusted 0-29');
  });

  it('refuses other browser origins and allows the configured one with CORS headers', async () => {
    const evil = await post(INITIALIZE, {
      authorization: `Bearer ${TOKEN}`,
      origin: 'https://evil.example',
    });
    expect(evil.status).toBe(403);
    const allowed = await post(INITIALIZE, {
      authorization: `Bearer ${TOKEN}`,
      origin: ALLOWED_ORIGIN,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    const preflight = await fetch(running.url, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    const unauthenticated = await post(INITIALIZE, { origin: ALLOWED_ORIGIN });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
  });

  it('refuses requests addressed to another host name (DNS rebinding)', async () => {
    expect(await rawRequest('evil.example:8787')).toBe(403);
    expect(await rawRequest(`localhost:${new URL(running.url).port}`)).toBe(200);
  });

  it('accepts only POST, valid JSON and bodies up to 1 MB', async () => {
    const get = await fetch(running.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    const invalid = await post('{not json', { authorization: `Bearer ${TOKEN}` });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as any).error.code).toBe(-32700);
    const huge = await post(`{"x":"${'a'.repeat(1_100_000)}"}`, {
      authorization: `Bearer ${TOKEN}`,
    });
    expect(huge.status).toBe(413);
  });

  it('serves a full MCP session to the SDK client', async () => {
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport as never);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(7);
    const result = (await client.callTool({
      name: TOOL_NAMES.searchHistory,
      arguments: { type: 'ip', value: '203.0.113.200', limit: 1, response_format: 'json' },
    })) as any;
    expect(JSON.parse(result.content[0].text).total).toBe(5);
    await client.close();
  });
});

describe('HTTP helpers', () => {
  it('generate random tokens and compare them safely', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateToken()).not.toBe(token);
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`bearer   ${token}  `, token)).toBe(true);
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized('Bearer', token)).toBe(false);
  });

  it('recognize loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('skip the Host check when bound to all interfaces', async () => {
    const ctx = createContext(buildServerConfig({}, { tools: undefined, offline: true }));
    const open = await startHttpServer({
      host: '0.0.0.0',
      port: 0,
      token: TOKEN,
      allowedOrigins: [],
      createMcpServer: () => createShieldLabsServer(ctx),
      log,
    });
    const port = new URL(open.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            host: 'mcp.internal.example',
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(INITIALIZE));
    });
    expect(status).toBe(200);
    await open.close();
  });
});
