import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { main, type MainResult, type Started } from '../src/cli.js';
import { parseArgs } from '../src/config.js';
import { SERVER_VERSION } from '../src/constants.js';
import { CHECK_CONNECTION_TOOL } from '../src/public/server.js';
import { startPublicHttpServer } from '../src/public/node.js';
import {
  bearer,
  CHALLENGE,
  fakePortal,
  GATEWAY_KEY,
  INITIALIZE,
  PORTAL_URL,
  PUBLIC_ORIGIN,
  TOKEN,
  PUBLIC_CONFIG,
  toolCall,
} from './public-helpers.js';

const ENV = {
  SHIELDLABS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  SHIELDLABS_PORTAL_URL: PORTAL_URL,
  MCP_GATEWAY_KEY: `${GATEWAY_KEY.kid}:${GATEWAY_KEY.secret}`,
};
const ARGS = ['--transport', 'http', '--mode', 'public', '--port', '0'];

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  return { stdout, stderr, out: () => out, err: () => err };
}

let running: Started | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function started(result: MainResult): Started {
  if (!('started' in result)) throw new Error(`exit code ${result.exitCode}`);
  running = result.started;
  return result.started;
}

/** Starts --mode public against the fake account API (real clock: the signature is timed). */
async function startPublic(env: Record<string, string> = ENV, args: string[] = ARGS) {
  const io = streams();
  const portal = fakePortal({ now: Date.now });
  const server = started(await main(args, { env, ...io, publicDeps: { fetch: portal.fetch } }));
  return { io, portal, server, url: server.http!.url };
}

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

describe('--mode public on Node.js', () => {
  it('aborts the signed backend operation when the HTTP client disconnects', async () => {
    const portal = fakePortal({ now: Date.now });
    let upstreamSignal: AbortSignal | undefined;
    let startedOperation: () => void = () => {};
    const begun = new Promise<void>((resolve) => {
      startedOperation = resolve;
    });
    const server = await startPublicHttpServer({
      host: '127.0.0.1',
      port: 0,
      config: PUBLIC_CONFIG,
      log: () => {},
      requestLog: () => {},
      deps: {
        fetch: (url, init) => {
          if (url.endsWith('/mcp/v1/ping')) return portal.fetch(url, init);
          upstreamSignal = init.signal;
          startedOperation();
          return new Promise(() => {});
        },
      },
    });
    const controller = new AbortController();
    const client = new Client({ name: 'disconnect-test', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: bearer(TOKEN) },
        }) as Transport,
      );
      const request = fetch(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...bearer(TOKEN),
        },
        body: JSON.stringify(toolCall('shieldlabs_list_domains', {})),
        signal: controller.signal,
      }).catch(() => undefined);
      await Promise.race([
        begun,
        request.then(() => {
          throw new Error('Tool request ended before reaching the backend');
        }),
      ]);
      controller.abort();
      await request;
      for (let i = 0; i < 50 && !upstreamSignal?.aborted; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('serves health, the metadata and the challenge over HTTP', async () => {
    const { url, io, server } = await startPublic();
    expect(io.err()).toContain(
      `in public mode (clients connect to ${PUBLIC_ORIGIN}/mcp; access tokens are checked by ${PORTAL_URL})`,
    );
    expect(server.public?.publicOrigin).toBe(PUBLIC_ORIGIN);
    expect(server.context.enabledTools.size).toBe(0);
    const health = await fetch(url.replace('/mcp', '/health'));
    expect(await health.json()).toEqual({ status: 'ok', version: SERVER_VERSION });
    const metadata = await fetch(url.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'));
    expect(((await metadata.json()) as any).authorization_servers).toEqual([PORTAL_URL]);
    const challenge = await post(url, JSON.stringify(INITIALIZE));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it('serves an MCP session to the SDK client and logs to stdout without the token', async () => {
    const { url, io, portal } = await startPublic();
    const client = new Client({ name: 'node-public-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport as never);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain(CHECK_CONNECTION_TOOL);
    expect(tools).toHaveLength(21);
    const result = (await client.callTool({ name: CHECK_CONNECTION_TOOL, arguments: {} })) as any;
    expect(result.structuredContent.connected).toBe(true);
    await client.close();
    // One ping when the token is first seen, one for the tool.
    expect(portal.calls).toHaveLength(2);
    const lines = io
      .out()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.some((line) => line.tool === CHECK_CONNECTION_TOOL)).toBe(true);
    for (const text of [io.out(), io.err()]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(GATEWAY_KEY.secret);
    }
  });

  it('reads a body only after authentication and answers oversized bodies with 413', async () => {
    const { url } = await startPublic();
    const huge = `{"x":"${'a'.repeat(1_100_000)}"}`;
    expect((await post(url, huge)).status).toBe(401);
    expect((await post(url, huge, bearer(TOKEN))).status).toBe(413);
    // Without Content-Length the limit applies while the body streams in.
    const chunk = new TextEncoder().encode('a'.repeat(100_000));
    let sent = 0;
    const streamed = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...bearer(TOKEN),
      },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 12) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      duplex: 'half',
    });
    expect(streamed.status).toBe(413);
    // The server still answers after draining those bodies.
    expect((await post(url, JSON.stringify(INITIALIZE), bearer(TOKEN))).status).toBe(200);
  });

  it('refuses unusable options and settings with exit code 2', async () => {
    const cases: [string[], Record<string, string>, string][] = [
      [['--mode', 'public'], ENV, '--mode public serves streamable HTTP only'],
      [
        [...ARGS, '--allowed-origins', 'https://a.example'],
        ENV,
        '--allowed-origins does not apply',
      ],
      [[...ARGS, '--tools', 'current_time'], ENV, '--tools does not apply to --mode public'],
      [ARGS, {}, 'Configuration error. SHIELDLABS_PUBLIC_ORIGIN is not set'],
      [ARGS, { ...ENV, MCP_GATEWAY_KEY: '' }, 'Configuration error. MCP_GATEWAY_KEY is not set'],
      [
        ARGS,
        { ...ENV, MCP_GATEWAY_KEY: `k1:${GATEWAY_KEY.secret.slice(0, 20)}` },
        'must have at least 32 bytes',
      ],
      [
        ARGS,
        { ...ENV, SHIELDLABS_PORTAL_URL: 'http://account.example.test' },
        'must be an https URL',
      ],
      [
        ['--transport', 'http', '--trust-proxy'],
        ENV,
        '--trust-proxy applies to --mode public only',
      ],
    ];
    for (const [args, env, message] of cases) {
      const io = streams();
      expect(await main(args, { env, ...io }), message).toEqual({ exitCode: 2 });
      expect(io.err()).toContain(message);
      expect(io.err()).not.toContain(GATEWAY_KEY.secret.slice(0, 20));
    }
    expect(() => parseArgs(['--mode', 'hosted'])).toThrow('--mode must be "local" or "public"');
    expect(parseArgs(['--mode=local']).mode).toBe('local');
    expect(() => parseArgs(['--trust-proxy=yes'])).toThrow('--trust-proxy does not take a value');
    expect(parseArgs(['--trust-proxy']).trustProxy).toBe(true);
  });

  it('limits per TCP connection address unless --trust-proxy takes it from CF-Connecting-IP', async () => {
    const challenge = (url: string, address: string) =>
      post(url, JSON.stringify(INITIALIZE), { 'cf-connecting-ip': address }).then(
        (response) => response.status,
      );
    const direct = await startPublic();
    expect(direct.io.err()).toContain(
      'Per-address rate limits use the address of each TCP connection.',
    );
    // 60 requests per minute without a token: a CF-Connecting-IP header sent by the client,
    // even one of Claude's egress network, changes nothing.
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      statuses.push(await challenge(direct.url, i % 2 === 0 ? `203.0.113.${i}` : '160.79.104.1'));
    }
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(401));
    expect(statuses[60]).toBe(429);
    await running!.close();
    running = undefined;

    const proxied = await startPublic(ENV, [...ARGS, '--trust-proxy']);
    expect(proxied.io.err()).toContain(
      'Client addresses come from CF-Connecting-IP (--trust-proxy)',
    );
    for (let i = 0; i < 61; i++) {
      expect(await challenge(proxied.url, '160.79.104.1')).toBe(401);
      expect(await challenge(proxied.url, '203.0.113.7')).toBe(i < 60 ? 401 : 429);
    }
    expect(await challenge(proxied.url, '203.0.113.8')).toBe(401);
  });

  it('warns about local settings it ignores and about a bind address without TLS', async () => {
    const { io } = await startPublic(
      { ...ENV, SHIELDLABS_API_KEY: 'sec_abcd1234-efgh5678-ijkl9012', SHIELDLABS_MCP_TOKEN: 'x' },
      [...ARGS, '--host', '0.0.0.0'],
    );
    expect(io.err()).toContain(
      '--mode public ignores SHIELDLABS_API_KEY, SHIELDLABS_MCP_TOKEN: every request brings its own access token.',
    );
    expect(io.err()).toContain('Bound to 0.0.0.0: put TLS in front of the server');
    expect(io.err()).not.toContain('sec_abcd1234');
  });

  it('reports a port that is already in use', async () => {
    const first = await startPublic();
    const port = new URL(first.url).port;
    const io = streams();
    expect(
      await main(['--transport', 'http', '--mode', 'public', '--port', port], { env: ENV, ...io }),
    ).toEqual({ exitCode: 1 });
    expect(io.err()).toContain(`Cannot listen on 127.0.0.1:${port} (EADDRINUSE)`);
  });
});
