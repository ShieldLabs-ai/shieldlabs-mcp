import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';
import {
  parseGatewayKey,
  PublicConfigError,
  publicConfigFromEnv,
  type PublicEnv,
} from '../src/public/config.js';
import { protectedResourceMetadata } from '../src/public/metadata.js';

const SECRET = 'gateway-test-secret-0123456789abcdef';
const DEV: PublicEnv = {
  SHIELDLABS_PUBLIC_ORIGIN: 'https://dev.mcp.shieldlabs.ai',
  SHIELDLABS_AUTH_ISSUER: 'https://dev.account.shieldlabs.ai',
  SHIELDLABS_PORTAL_URL: 'https://dev.account.shieldlabs.ai',
  MCP_GATEWAY_KEY: `k1:${SECRET}`,
};

function refusal(env: PublicEnv): string {
  try {
    publicConfigFromEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(PublicConfigError);
    return (error as Error).message;
  }
  throw new Error('expected a PublicConfigError');
}

describe('public-mode settings', () => {
  it('read the origins and the gateway key', () => {
    expect(publicConfigFromEnv(DEV)).toEqual({
      publicOrigin: 'https://dev.mcp.shieldlabs.ai',
      authIssuer: 'https://dev.account.shieldlabs.ai',
      portalUrl: 'https://dev.account.shieldlabs.ai',
      gatewayKey: { kid: 'k1', secret: SECRET },
    });
    expect(
      publicConfigFromEnv({
        ...DEV,
        SHIELDLABS_PUBLIC_ORIGIN: ' https://MCP.example.test/ ',
        SHIELDLABS_AUTH_ISSUER: '',
        SHIELDLABS_PORTAL_URL: 'http://localhost:8090',
      }),
    ).toMatchObject({
      publicOrigin: 'https://mcp.example.test',
      authIssuer: 'http://localhost:8090',
      portalUrl: 'http://localhost:8090',
    });
  });

  it('have no default origin, so an environment never falls back to another', () => {
    expect(refusal({ ...DEV, SHIELDLABS_PUBLIC_ORIGIN: undefined })).toContain(
      'SHIELDLABS_PUBLIC_ORIGIN is not set',
    );
    expect(refusal({ ...DEV, SHIELDLABS_PORTAL_URL: ' ' })).toContain(
      'SHIELDLABS_PORTAL_URL is not set',
    );
  });

  it('refuse plain http outside loopback hosts, paths and values that are not URLs', () => {
    expect(
      refusal({ ...DEV, SHIELDLABS_PORTAL_URL: 'http://dev.account.shieldlabs.ai' }),
    ).toContain('SHIELDLABS_PORTAL_URL must be an https URL');
    expect(refusal({ ...DEV, SHIELDLABS_PUBLIC_ORIGIN: 'https://mcp.example.test/mcp' })).toContain(
      'must be an origin without a path',
    );
    expect(refusal({ ...DEV, SHIELDLABS_AUTH_ISSUER: 'account' })).toContain(
      'SHIELDLABS_AUTH_ISSUER must be an absolute URL',
    );
  });

  it('refuse a gateway key the ShieldLabs API would refuse, without quoting it', () => {
    expect(refusal({ ...DEV, MCP_GATEWAY_KEY: undefined })).toContain('MCP_GATEWAY_KEY is not set');
    for (const value of [
      SECRET,
      `:${SECRET}`,
      `k 1:${SECRET}`,
      `${'k'.repeat(33)}:${SECRET}`,
      'k1:too-short-secret',
      `k1:${SECRET} with space`,
      `k1:${SECRET},k2:${SECRET}`,
    ]) {
      const message = refusal({ ...DEV, MCP_GATEWAY_KEY: value });
      expect(message, value).toContain('MCP_GATEWAY_KEY');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain('too-short-secret');
    }
    expect(parseGatewayKey(`key.2026-10_a:${SECRET}:with-colon`)).toEqual({
      kid: 'key.2026-10_a',
      secret: `${SECRET}:with-colon`,
    });
  });
});

describe('wrangler.jsonc', () => {
  const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
  const read = (env: string | undefined) =>
    unstable_readConfig({ config: configPath, env }, { hideWarnings: true });

  it('deploys Development as shieldlabs-mcp-dev on dev.mcp.shieldlabs.ai', () => {
    const dev = read('dev');
    expect(dev.name).toBe('shieldlabs-mcp-dev');
    expect(dev.routes).toEqual([{ pattern: 'dev.mcp.shieldlabs.ai', custom_domain: true }]);
    expect(dev.workers_dev).toBe(false);
    expect(dev.vars).toEqual({
      INSTALLER_ENABLED: 'false',
      SHIELDLABS_PUBLIC_ORIGIN: 'https://dev.mcp.shieldlabs.ai',
      SHIELDLABS_AUTH_ISSUER: 'https://dev.account.shieldlabs.ai',
      SHIELDLABS_PORTAL_URL: 'https://dev.account.shieldlabs.ai',
    });
    const config = publicConfigFromEnv({
      ...(dev.vars as PublicEnv),
      MCP_GATEWAY_KEY: `k1:${SECRET}`,
    });
    expect(protectedResourceMetadata(config)).toMatchObject({
      resource: 'https://dev.mcp.shieldlabs.ai/mcp',
      authorization_servers: ['https://dev.account.shieldlabs.ai'],
    });
  });

  it('deploys Production as shieldlabs-mcp on mcp.shieldlabs.ai, with the same shape', () => {
    const dev = read('dev');
    const production = read('production');
    expect(production.name).toBe('shieldlabs-mcp');
    expect(production.routes).toEqual([{ pattern: 'mcp.shieldlabs.ai', custom_domain: true }]);
    expect(production.workers_dev).toBe(false);
    expect(production.vars).toEqual({
      INSTALLER_ENABLED: 'false',
      SHIELDLABS_PUBLIC_ORIGIN: 'https://mcp.shieldlabs.ai',
      SHIELDLABS_AUTH_ISSUER: 'https://account.shieldlabs.ai',
      SHIELDLABS_PORTAL_URL: 'https://account.shieldlabs.ai',
    });
    type RateLimit = { name: string; namespace_id: string; simple: unknown };
    const limits = (config: typeof dev) => config.ratelimits as RateLimit[];
    const shape = (config: typeof dev) =>
      limits(config).map(({ name, simple }) => ({ name, simple }));
    expect(shape(production)).toEqual(shape(dev));
    expect(shape(dev).map(({ name }) => name)).toEqual([
      'RL_INSTALLER_IP',
      'RL_TOKEN',
      'RL_ANON',
      'RL_TOKEN_CHECK',
    ]);
    expect(shape(dev).find(({ name }) => name === 'RL_INSTALLER_IP')?.simple).toEqual({
      limit: 10,
      period: 60,
    });
    const namespaces = [...limits(dev), ...limits(production)].map((rl) => rl.namespace_id);
    expect(new Set(namespaces).size).toBe(8);
  });

  it('never deploys Production by default or commits the gateway key', () => {
    const top = read(undefined);
    const dev = read('dev');
    for (const key of ['name', 'routes', 'vars', 'ratelimits', 'workers_dev'] as const) {
      expect(top[key], key).toEqual(dev[key]);
    }
    for (const config of [top, dev, read('production')]) {
      expect(Object.keys(config.vars)).not.toContain('MCP_GATEWAY_KEY');
      expect(Object.keys(config.vars)).not.toContain('INSTALLER_ANTHROPIC_API_KEY');
      expect(config.vars.INSTALLER_ENABLED).toBe('false');
      expect(config.compatibility_flags).toEqual([]);
      expect(config.main).toMatch(/src\/worker\.ts$/);
    }
  });
});
