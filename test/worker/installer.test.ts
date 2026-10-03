import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import Worker from '../../src/worker.js';
import { OPENBROKER_URL, OPENBROKER_MODELS } from '../../src/installer/openbroker.js';
import {
  harness,
  installerRequest,
  installerSuite,
  config,
  input,
  ORIGIN,
  proposal,
} from '../installer-cases.js';

installerSuite();

it('OpenBroker opt-in runs in workerd after fresh authorization without changing Claude default', async () => {
  const h = harness();
  const { vi } = await import('vitest');
  h.provider.mockResolvedValue(
    Response.json({
      model: OPENBROKER_MODELS[0],
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(proposal) },
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return address.startsWith(config.portalUrl) ? h.portal(url, init) : h.provider(url, init);
  });
  const env = {
    ...h.env,
    INSTALLER_PROVIDER: 'openbroker',
    INSTALLER_OPENBROKER_MODEL: OPENBROKER_MODELS[0],
    INSTALLER_OPENBROKER_API_KEY: `obk-${'fixture'.repeat(5)}`,
    SHIELDLABS_PUBLIC_ORIGIN: ORIGIN,
    SHIELDLABS_PORTAL_URL: config.portalUrl,
    MCP_GATEWAY_KEY: `k1:${config.gatewayKey.secret}`,
  };
  const response = await Worker.fetch(installerRequest(), env, { waitUntil: () => undefined });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(proposal);
  expect(h.portal).toHaveBeenCalledTimes(1);
  expect(h.provider).toHaveBeenCalledTimes(1);
  expect(h.provider.mock.calls[0]![0]).toBe(OPENBROKER_URL);
});

it('Worker delegates exactly /installer/plan; enabled gateway runs in workerd with real SDK', async () => {
  const h = harness();
  const { vi } = await import('vitest');
  vi.stubGlobal('fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return address.startsWith(config.portalUrl) ? h.portal(url, init) : h.provider(url, init);
  });
  const env = {
    ...h.env,
    SHIELDLABS_PUBLIC_ORIGIN: ORIGIN,
    SHIELDLABS_PORTAL_URL: config.portalUrl,
    MCP_GATEWAY_KEY: `k1:${config.gatewayKey.secret}`,
  };
  const response = await Worker.fetch(installerRequest(), env, { waitUntil: () => undefined });
  expect(response.status).toBe(200);
  expect(h.portal).toHaveBeenCalledTimes(1);
  expect(h.provider).toHaveBeenCalledTimes(1);
  const other = await Worker.fetch(new Request(`${ORIGIN}/installer/other`), env, {
    waitUntil: () => undefined,
  });
  expect(other.status).toBe(404);
  expect(h.provider).toHaveBeenCalledTimes(1);
});

it('Wrangler dev feature defaults off; SELF route makes no upstream call', async () => {
  const { vi } = await import('vitest');
  const network = vi.fn();
  vi.stubGlobal('fetch', network);
  const response = await SELF.fetch('https://dev.mcp.shieldlabs.ai/installer/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.9' },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(503);
  expect(network).not.toHaveBeenCalled();
});
