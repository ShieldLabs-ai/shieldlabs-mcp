import { describe, expect, it, vi } from 'vitest';
import worker, { type WorkerEnv } from '../src/worker.js';
import {
  bearer,
  fakePortal,
  GATEWAY_KEY,
  INITIALIZE,
  mcpRequest,
  PORTAL_URL,
  PUBLIC_ORIGIN,
  TOKEN,
} from './public-helpers.js';

// test/worker/ runs the Worker in workerd; this covers the entry's wiring on Node.js.
const ENV: WorkerEnv = {
  SHIELDLABS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  SHIELDLABS_PORTAL_URL: PORTAL_URL,
  MCP_GATEWAY_KEY: `${GATEWAY_KEY.kid}:${GATEWAY_KEY.secret}`,
};

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (promise: Promise<unknown>) => pending.push(promise), pending };
}

describe('Worker entry', () => {
  it('serves public mode with the rate limiters and waitUntil of the Worker', async () => {
    const portal = fakePortal({ now: Date.now });
    vi.stubGlobal('fetch', portal.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const anon = { limit: vi.fn(async () => ({ success: true })) };
    const token = { limit: vi.fn(async () => ({ success: true })) };
    const tokenCheck = { limit: vi.fn(async () => ({ success: true })) };
    const ctx = executionContext();
    const env = { ...ENV, RL_ANON: anon, RL_TOKEN: token, RL_TOKEN_CHECK: tokenCheck };
    const from = { 'cf-connecting-ip': '192.0.2.9' };
    expect((await worker.fetch(mcpRequest(INITIALIZE, from), env, ctx)).status).toBe(401);
    const ok = await worker.fetch(mcpRequest(INITIALIZE, { ...from, ...bearer(TOKEN) }), env, ctx);
    expect(ok.status).toBe(200);
    expect(anon.limit).toHaveBeenCalledExactlyOnceWith({ key: 'ip:192.0.2.9' });
    expect(token.limit).toHaveBeenCalledOnce();
    expect(tokenCheck.limit).toHaveBeenCalledExactlyOnceWith({ key: 'ip:192.0.2.9' });
    expect(portal.calls).toHaveLength(1);
    expect(ctx.pending).toHaveLength(1);
    await Promise.all(ctx.pending);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({
      route: '/mcp',
      status: 200,
      check: 'ok',
    });
  });

  it('answers 500 and names the setting to fix when the gateway key is missing', async () => {
    const portal = fakePortal();
    vi.stubGlobal('fetch', portal.fetch);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await worker.fetch(
      new Request(`${PUBLIC_ORIGIN}/health`, { headers: { 'cf-ray': '8c1f-AMS' } }),
      { ...ENV, MCP_GATEWAY_KEY: undefined },
      executionContext(),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'server_error' });
    expect(portal.calls).toHaveLength(0);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      rid: '8c1f-AMS',
      route: '/health',
      status: 500,
      error: 'PublicConfigError',
    });
    expect(line.message).toContain('MCP_GATEWAY_KEY is not set');
  });

  it('never quotes the gateway secret when the key is malformed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const secret = 'a-secret-without-its-key-id-0123456789';
    const response = await worker.fetch(
      mcpRequest(INITIALIZE, bearer(TOKEN)),
      { ...ENV, MCP_GATEWAY_KEY: secret },
      executionContext(),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[0]![0] as string).message).toContain('kid:secret');
  });
});
