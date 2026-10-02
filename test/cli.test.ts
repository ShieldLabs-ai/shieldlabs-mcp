import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, warnShortToken, type MainResult, type Started } from '../src/cli.js';
import { buildServerConfig } from '../src/config.js';
import { createContext } from '../src/context.js';
import { FULL_ENV, mockApiFetch } from './helpers.js';

function streams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  return { stdout, stderr, out: () => out, err: () => err };
}

function started(result: MainResult): Started {
  if (!('started' in result))
    throw new Error(`expected a running server, got exit code ${result.exitCode}`);
  return result.started;
}

describe('main()', () => {
  it('prints help and the version to stdout', async () => {
    const io = streams();
    expect(await main(['--help'], { env: {}, ...io })).toEqual({ exitCode: 0 });
    expect(io.out()).toContain('Usage: shieldlabs-mcp [options]');
    expect(io.out()).toContain('SHIELDLABS_MCP_TOKEN');
    expect(io.out()).toContain('shieldlabs_get_identification');
    expect(io.out()).toContain(
      'Local tools are read-only. Hosted mode also manages domains and webhooks.',
    );
    expect(io.out()).toContain('Local mode only: comma-separated allowlist');
    const version = streams();
    expect(await main(['-v'], { env: {}, ...version })).toEqual({ exitCode: 0 });
    expect(version.out()).toBe('1.0.0\n');
  });

  it('reports usage errors on stderr with exit code 2', async () => {
    const io = streams();
    expect(await main(['--transport', 'carrier-pigeon'], { env: {}, ...io })).toEqual({
      exitCode: 2,
    });
    expect(io.err()).toContain('--transport must be "stdio" or "http"');
    expect(io.err()).toContain('--help');
    expect(io.out()).toBe('');
  });

  it('reports an unusable base URL as a configuration error without the key', async () => {
    const io = streams();
    const result = await main([], {
      env: {
        SHIELDLABS_API_KEY: FULL_ENV.SHIELDLABS_API_KEY,
        SHIELDLABS_API_BASE_URL: 'not a url',
      },
      ...io,
    });
    expect(result).toEqual({ exitCode: 2 });
    expect(io.err()).toContain(
      'Configuration error. Check SHIELDLABS_API_KEY and SHIELDLABS_API_BASE_URL: baseUrl is not a valid URL.',
    );
    expect(io.err()).not.toContain(FULL_ENV.SHIELDLABS_API_KEY);
  });

  it('refuses plain http base URLs outside loopback hosts, accepts them on loopback', async () => {
    const refused: [Record<string, string>, string][] = [
      [
        {
          SHIELDLABS_API_KEY: FULL_ENV.SHIELDLABS_API_KEY,
          SHIELDLABS_API_BASE_URL: 'http://account.shieldlabs.ai',
        },
        'SHIELDLABS_API_BASE_URL must be an https URL, such as the default https://account.shieldlabs.ai',
      ],
      [
        {
          SHIELDLABS_SECRET_KEY: FULL_ENV.SHIELDLABS_SECRET_KEY,
          SHIELDLABS_DOMAIN: 'example.com',
          SHIELDLABS_MANAGEMENT_BASE_URL: 'http://192.0.2.10:8080',
        },
        'SHIELDLABS_MANAGEMENT_BASE_URL must be an https URL, such as the default https://api.shieldlabs.ai',
      ],
    ];
    for (const [env, message] of refused) {
      const io = streams();
      expect(await main([], { env, ...io })).toEqual({ exitCode: 2 });
      expect(io.err()).toContain(`Configuration error. ${message}`);
      expect(io.err()).toContain('would travel unencrypted');
      expect(io.err()).not.toContain(FULL_ENV.SHIELDLABS_API_KEY);
    }
    for (const base of [
      'http://localhost:8788',
      'http://127.0.0.1:8788',
      'http://127.1.2.3',
      'http://[::1]:8788',
      'http://mock.localhost:8788',
      'https://account.example.test',
    ]) {
      const ctx = createContext(
        buildServerConfig(
          {
            SHIELDLABS_API_KEY: FULL_ENV.SHIELDLABS_API_KEY,
            SHIELDLABS_API_BASE_URL: base,
            SHIELDLABS_SECRET_KEY: FULL_ENV.SHIELDLABS_SECRET_KEY,
            SHIELDLABS_DOMAIN: 'example.com',
            SHIELDLABS_MANAGEMENT_BASE_URL: base,
          },
          { tools: undefined, offline: true },
        ),
      );
      expect(ctx.history, base).toBeDefined();
      expect(ctx.management, base).toBeDefined();
    }
    // Plain http without the matching key is not used, so it is not an error.
    const unused = createContext(
      buildServerConfig(
        { SHIELDLABS_API_BASE_URL: 'http://192.0.2.1' },
        { tools: undefined, offline: true },
      ),
    );
    expect(unused.history).toBeUndefined();
  });

  it('says why the domain profile is disabled when only half of its settings are present', async () => {
    const io = streams();
    const stdin = new PassThrough();
    const server = started(
      await main([], { env: { SHIELDLABS_DOMAIN: 'example.com' }, ...io, stdin }),
    );
    expect(io.err()).toContain('SHIELDLABS_SECRET_KEY is not set, so the Management API');
    await server.close();
  });

  it('serves MCP on stdio and keeps stdout for the protocol', async () => {
    const io = streams();
    const stdin = new PassThrough();
    const server = started(
      await main(['--tools', 'current_time,get_domain_profile'], {
        env: { SHIELDLABS_API_KEY: FULL_ENV.SHIELDLABS_API_KEY },
        ...io,
        stdin,
        deps: { apiFetch: mockApiFetch().fetch },
      }),
    );
    expect(server.mode).toBe('stdio');
    expect(io.err()).toContain('running on stdio');
    expect(io.err()).toContain(
      '--tools lists shieldlabs_get_domain_profile, which needs SHIELDLABS_SECRET_KEY and SHIELDLABS_DOMAIN',
    );
    const reply = new Promise<string>((resolve) => {
      io.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`,
    );
    const message = JSON.parse(await reply);
    expect(message.result.serverInfo.name).toBe('shieldlabs-mcp');
    await server.close();
  });

  it('starts over HTTP, generating and printing a token when none is set', async () => {
    const io = streams();
    const server = started(
      await main(['--transport', 'http', '--port', '0', '--allowed-origins', 'https://a.example'], {
        env: {},
        ...io,
      }),
    );
    expect(server.mode).toBe('http');
    expect(io.err()).toContain('SHIELDLABS_MCP_TOKEN is not set. Generated a bearer token');
    expect(io.err()).toContain('starting with offline tools only');
    const token = io.err().match(/every start\): (\S+)/)![1]!;
    const health = await fetch(server.http!.url.replace('/mcp', '/health'));
    expect(health.status).toBe(200);
    const unauthorized = await fetch(server.http!.url, { method: 'POST', body: '{}' });
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(server.http!.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }),
    });
    expect(authorized.status).toBe(200);
    await server.close();
  });

  it('warns about a short bearer token, louder beyond loopback', async () => {
    const local = streams();
    const running = started(
      await main(['--transport', 'http', '--port', '0'], {
        env: { SHIELDLABS_MCP_TOKEN: 'a' },
        ...local,
      }),
    );
    expect(local.err()).toContain(
      'SHIELDLABS_MCP_TOKEN has only 1 character. Use a random value of at least 32 characters, for example the output of: openssl rand -hex 32.',
    );
    expect(local.err()).not.toContain('WARNING');
    await running.close();

    const long = streams();
    const fine = started(
      await main(['--transport', 'http', '--port', '0'], {
        env: { SHIELDLABS_MCP_TOKEN: 'x'.repeat(32) },
        ...long,
      }),
    );
    expect(long.err()).not.toContain('SHIELDLABS_MCP_TOKEN has only');
    await fine.close();

    const lines: string[] = [];
    warnShortToken('short-token', '0.0.0.0', (line) => lines.push(line));
    expect(lines).toEqual([
      'WARNING: SHIELDLABS_MCP_TOKEN has only 11 characters and the server is bound to 0.0.0.0, where other machines can try to guess it. Use a random value of at least 32 characters, for example the output of: openssl rand -hex 32.',
    ]);
    expect(lines.join('')).not.toContain('short-token');
  });

  it('reports a busy port with a hint instead of a stack trace', async () => {
    const first = streams();
    const running = started(
      await main(['--transport', 'http', '--port', '0'], { env: {}, ...first }),
    );
    const port = new URL(running.http!.url).port;
    const second = streams();
    expect(await main(['--transport', 'http', '--port', port], { env: {}, ...second })).toEqual({
      exitCode: 1,
    });
    expect(second.err()).toContain(`Cannot listen on 127.0.0.1:${port} (EADDRINUSE)`);
    await running.close();
  });

  it('refuses keys and domains that cannot travel in an HTTP header, without echoing them', async () => {
    const cases: [Record<string, string>, string, string][] = [
      [
        { SHIELDLABS_API_KEY: 'sec_abcd1234-abcd1234-abcd1234\nX-Injected: 1' },
        'Check SHIELDLABS_API_KEY and SHIELDLABS_API_BASE_URL: apiKey contains characters that cannot be sent in an HTTP header',
        'X-Injected',
      ],
      [
        { SHIELDLABS_SECRET_KEY: 'secret value with spaces', SHIELDLABS_DOMAIN: 'example.com' },
        'Check SHIELDLABS_SECRET_KEY, SHIELDLABS_DOMAIN and SHIELDLABS_MANAGEMENT_BASE_URL: secretKey contains characters that cannot be sent in an HTTP header',
        'secret value',
      ],
      [
        { SHIELDLABS_SECRET_KEY: 'secret-value', SHIELDLABS_DOMAIN: 'bücher.example' },
        'Check SHIELDLABS_SECRET_KEY, SHIELDLABS_DOMAIN and SHIELDLABS_MANAGEMENT_BASE_URL: domain must be ASCII: pass the punycode form (xn--...)',
        'secret-value',
      ],
    ];
    for (const [env, message, hidden] of cases) {
      const io = streams();
      expect(await main([], { env, ...io })).toEqual({ exitCode: 2 });
      expect(io.err()).toContain(`Configuration error. ${message}`);
      expect(io.err()).not.toContain(hidden);
    }
  });

  it('names the settings to check when the Management API configuration is unusable', async () => {
    const io = streams();
    const result = await main([], {
      env: {
        SHIELDLABS_SECRET_KEY: 'secret-value',
        SHIELDLABS_DOMAIN: 'https://',
      },
      ...io,
    });
    expect(result).toEqual({ exitCode: 2 });
    expect(io.err()).toContain(
      'Check SHIELDLABS_SECRET_KEY, SHIELDLABS_DOMAIN and SHIELDLABS_MANAGEMENT_BASE_URL',
    );
    expect(io.err()).not.toContain('secret-value');
  });

  it('uses SHIELDLABS_MCP_TOKEN and warns when bound beyond loopback', async () => {
    const io = streams();
    const server = started(
      await main(['--transport=http', '--port=0', '--host=0.0.0.0'], {
        env: { SHIELDLABS_MCP_TOKEN: 'fixed-token-value' },
        ...io,
      }),
    );
    expect(io.err()).not.toContain('Generated a bearer token');
    expect(io.err()).not.toContain('fixed-token-value');
    expect(io.err()).toContain('other machines can reach this port');
    await server.close();
  });
});
