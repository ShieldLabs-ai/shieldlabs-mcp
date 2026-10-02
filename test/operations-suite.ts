import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ID,
  HOOK_ID,
  REQUEST_ID,
  DOMAIN_PATH,
  HOOK_PATH,
  HOSTED_TOKEN,
  SECOND_TOKEN,
  RAW_KEY,
  RAW_SECRET,
  operationsBackend,
  verifyRequest,
  UPSTREAM,
} from './operations-backend.js';

type Backend = ReturnType<typeof operationsBackend>;
type Host = (backend: Backend) => { fetch: typeof globalThis.fetch; logs?: string[] };

const cases: [string, Record<string, unknown>, string, string, unknown?][] = [
  ['shieldlabs_list_domains', {}, 'GET', '/mcp/v1/domains'],
  ['shieldlabs_get_domain', { domain_id: DOMAIN_ID }, 'GET', DOMAIN_PATH],
  [
    'shieldlabs_create_domain',
    { domain: 'example.com', allow_subdomains: false },
    'POST',
    '/mcp/v1/domains',
    { domain: 'example.com', allow_subdomains: false },
  ],
  [
    'shieldlabs_patch_domain',
    { domain_id: DOMAIN_ID, allow_subdomains: false },
    'PATCH',
    DOMAIN_PATH,
    { allow_subdomains: false },
  ],
  ['shieldlabs_delete_domain', { domain_id: DOMAIN_ID, confirm: true }, 'DELETE', DOMAIN_PATH],
  [
    'shieldlabs_rotate_server_key',
    { domain_id: DOMAIN_ID, confirm: true },
    'POST',
    `${DOMAIN_PATH}/server-key/rotate`,
  ],
  ['shieldlabs_list_webhooks', { domain_id: DOMAIN_ID }, 'GET', `${DOMAIN_PATH}/webhooks`],
  ['shieldlabs_get_webhook', { domain_id: DOMAIN_ID, webhook_id: HOOK_ID }, 'GET', HOOK_PATH],
  [
    'shieldlabs_create_webhook',
    { domain_id: DOMAIN_ID, name: 'Production', url: 'https://example.com/hook' },
    'POST',
    `${DOMAIN_PATH}/webhooks`,
    { name: 'Production', url: 'https://example.com/hook' },
  ],
  [
    'shieldlabs_patch_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID, name: 'Renamed' },
    'PATCH',
    HOOK_PATH,
    { name: 'Renamed' },
  ],
  [
    'shieldlabs_delete_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID, confirm: true },
    'DELETE',
    HOOK_PATH,
  ],
  [
    'shieldlabs_enable_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID },
    'POST',
    `${HOOK_PATH}/enable`,
  ],
  [
    'shieldlabs_disable_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID, confirm: true },
    'POST',
    `${HOOK_PATH}/disable`,
  ],
  [
    'shieldlabs_rotate_webhook_secret',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID, confirm: true },
    'POST',
    `${HOOK_PATH}/rotate-secret`,
  ],
  [
    'shieldlabs_verify_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID },
    'POST',
    `${HOOK_PATH}/verify`,
  ],
  [
    'shieldlabs_test_webhook',
    { domain_id: DOMAIN_ID, webhook_id: HOOK_ID },
    'POST',
    `${HOOK_PATH}/test`,
  ],
];

async function connect(host: ReturnType<Host>, token = HOSTED_TOKEN) {
  const client = new Client({ name: 'operations-contract-test', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('https://dev.mcp.shieldlabs.ai/mcp'), {
      fetch: host.fetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as Transport,
  );
  return client;
}

/** Same actual MCP Client suite runs through Node handler and the Worker entry in workerd. */
export function operationsSuite(host: Host) {
  describe('hosted operations contract', () => {
    it('matches webhook name code-point and URL UTF-8 byte boundaries on create and patch', async () => {
      const backend = operationsBackend();
      const client = await connect(host(backend));
      try {
        const tools = (await client.listTools()).tools;
        const prefix = 'https://example.com/';
        const url512 = prefix + 'a'.repeat(512 - prefix.length);
        const utf8Url512 = prefix + '\u00e9'.repeat((512 - prefix.length) / 2);
        expect(new TextEncoder().encode(utf8Url512)).toHaveLength(512);
        for (const toolName of ['shieldlabs_create_webhook', 'shieldlabs_patch_webhook']) {
          const properties = tools.find((tool) => tool.name === toolName)!.inputSchema.properties!;
          expect(properties.name).toMatchObject({ maxLength: 80 });
          expect(properties.url).toMatchObject({ maxLength: 512 });
          expect(JSON.stringify(properties.url)).toContain('512 UTF-8 bytes');
          const base = {
            domain_id: DOMAIN_ID,
            ...(toolName.endsWith('patch_webhook') ? { webhook_id: HOOK_ID, confirm: true } : {}),
          };
          for (const [name, url, accepted] of [
            ['a'.repeat(80), url512, true],
            ['a'.repeat(81), url512, false],
            ['\u{1f600}'.repeat(80), utf8Url512, true],
            ['\u{1f600}'.repeat(81), utf8Url512, false],
            ['Valid', url512 + 'a', false],
            ['Valid', utf8Url512 + 'a', false],
            ['\u0085' + '\u{1f600}'.repeat(80) + '\u0085', ' ' + utf8Url512 + ' ', true],
          ] as const) {
            const before = backend.calls.length;
            const reply = await client.callTool({
              name: toolName,
              arguments: { ...base, name, url },
            });
            expect(reply.isError === true, `${toolName}: accepted=${accepted}`).toBe(!accepted);
            expect(backend.calls).toHaveLength(before + (accepted ? 1 : 0));
            if (accepted) {
              const body = JSON.parse(backend.calls.at(-1)!.body);
              expect([...body.name].length).toBeLessThanOrEqual(80);
              expect(new TextEncoder().encode(body.url).byteLength).toBeLessThanOrEqual(512);
              expect(body.name).not.toContain('\u0085');
            }
          }
        }
      } finally {
        await client.close();
      }
    });

    it('accepts only IPv4-convertible history IPs and refuses pure IPv6 before forwarding', async () => {
      const backend = operationsBackend();
      const client = await connect(host(backend));
      try {
        const tools = (await client.listTools()).tools;
        for (const name of ['shieldlabs_search_history', 'shieldlabs_summarize_entity']) {
          expect(JSON.stringify(tools.find((tool) => tool.name === name)!.inputSchema)).toContain(
            'pure IPv6 is not searchable',
          );
          for (const value of ['2001:db8::1', '::1', '::203.0.113.24', 'not-an-ip', '256.0.0.1']) {
            const before = backend.calls.length;
            const reply = await client.callTool({ name, arguments: { type: 'ip', value } });
            expect(reply.isError).toBe(true);
            expect(JSON.stringify(reply)).toContain('IPv4 or IPv4-mapped IPv6 only');
            expect(JSON.stringify(reply)).not.toContain('502');
            expect(backend.calls).toHaveLength(before);
          }
          for (const value of [
            '203.0.113.24',
            '::ffff:203.0.113.24',
            '::ffff:cb00:7118',
            '0:0:0:0:0:ffff:cb00:7118',
          ]) {
            const reply = await client.callTool({ name, arguments: { type: 'ip', value } });
            expect(reply.isError).not.toBe(true);
            expect(backend.calls.at(-1)!.path).toContain('/ip/203.0.113.24?');
          }
        }
      } finally {
        await client.close();
      }
    });

    it('retries transient reads within the polling budget with fresh signatures', async () => {
      const backend = operationsBackend();
      const client = await connect(host(backend));
      try {
        backend.failNext(500);
        backend.failNext(429);
        const reply = await client.callTool({
          name: 'shieldlabs_get_identification',
          arguments: { request_id: REQUEST_ID, wait: true },
        });
        expect(reply.isError).not.toBe(true);
        expect(
          backend.calls.filter((call) => call.path.startsWith('/mcp/v1/requests/')),
        ).toHaveLength(3);
        expect(backend.seen.size).toBe(backend.calls.length);
      } finally {
        await client.close();
      }
    });
    it('validates signatures, raw bodies, paths, methods and discovery for every management operation', async () => {
      const backend = operationsBackend();
      const instance = host(backend);
      const client = await connect(instance);
      try {
        const tools = (await client.listTools()).tools;
        expect(tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(cases.map(([name]) => name)),
        );
        for (const [name, args, method, path, body] of cases) {
          const tool = tools.find((tool) => tool.name === name)!;
          expect(tool.annotations?.readOnlyHint).toBe(method === 'GET');
          const reply = await client.callTool({ name, arguments: args });
          expect(reply.isError, `${name}: ${JSON.stringify(reply)}`).not.toBe(true);
          const call = backend.calls.at(-1)!;
          expect(call.method).toBe(method);
          expect(call.path).toBe(path);
          expect(call.body).toBe(body === undefined ? '' : JSON.stringify(body));
          expect(JSON.stringify(reply)).not.toContain(RAW_KEY);
          expect(JSON.stringify(reply)).not.toContain(RAW_SECRET);
          expect(call.init.redirect).toBe('manual');
          if (method !== 'GET') expect(call.init.headers['X-Shield-Gateway']).toMatch(/^v2 /);
        }
        expect(backend.seen.size).toBe(backend.calls.length);
        const mutation = backend.calls.find((call) => call.method === 'PATCH')!;
        await expect(
          verifyRequest(
            new URL(`${UPSTREAM}${mutation.path}`),
            { ...mutation.init, body: '{"allow_subdomains":true}' },
            new Set(),
          ),
        ).rejects.toThrow('Signature mismatch');
        await expect(
          verifyRequest(new URL(`${UPSTREAM}${mutation.path}`), mutation.init, backend.seen),
        ).rejects.toThrow('Replayed nonce');
        expect((await client.listResources()).resources).toHaveLength(4);
        expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain(
          'integrate_shieldlabs',
        );
        const reference = await client.readResource({ uri: 'shieldlabs://reference/risk-bands' });
        expect(JSON.stringify(reference)).toContain('dangerous');
        const prompt = await client.getPrompt({ name: 'integrate_shieldlabs' });
        expect(JSON.stringify(prompt)).toContain('include_secret=true');
        expect(JSON.stringify(instance.logs)).not.toContain(RAW_KEY);
        expect(JSON.stringify(instance.logs)).not.toContain(RAW_SECRET);
      } finally {
        await client.close();
      }
    }, 20_000);

    it('returns sensitive one-time credentials only with explicit opt-in', async () => {
      const backend = operationsBackend();
      const instance = host(backend);
      const client = await connect(instance);
      try {
        for (const [name, args] of cases.filter(([name]) =>
          /create_domain|rotate_server_key|create_webhook|rotate_webhook_secret/.test(name),
        )) {
          const reply = await client.callTool({
            name,
            arguments: { ...args, include_secret: true },
          });
          expect(reply.isError).not.toBe(true);
          expect(reply.structuredContent).toMatchObject({ sensitive: true, one_time: true });
          expect(JSON.stringify(reply.structuredContent)).toContain(
            name.includes('webhook') ? RAW_SECRET : RAW_KEY,
          );
          expect(JSON.stringify(reply.content)).not.toContain(RAW_KEY);
          expect(JSON.stringify(reply.content)).not.toContain(RAW_SECRET);
        }
        expect(JSON.stringify(instance.logs)).not.toContain(RAW_KEY);
        expect(JSON.stringify(instance.logs)).not.toContain(RAW_SECRET);
      } finally {
        await client.close();
      }
    });

    it('rejects destructive operations without confirm and refuses empty patches before forwarding', async () => {
      const backend = operationsBackend();
      const client = await connect(host(backend));
      try {
        const before = backend.calls.length;
        for (const [name, args] of cases.filter(([name]) => /delete|rotate|disable/.test(name))) {
          const { confirm: _confirm, ...without } = args;
          expect((await client.callTool({ name, arguments: without })).isError).toBe(true);
        }
        expect(
          (
            await client.callTool({
              name: 'shieldlabs_patch_domain',
              arguments: { domain_id: DOMAIN_ID, enabled: false },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: 'shieldlabs_patch_domain',
              arguments: { domain_id: DOMAIN_ID },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: 'shieldlabs_patch_webhook',
              arguments: { domain_id: DOMAIN_ID, webhook_id: HOOK_ID },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name: 'shieldlabs_patch_webhook',
              arguments: {
                domain_id: DOMAIN_ID,
                webhook_id: HOOK_ID,
                url: 'https://example.com/new',
              },
            })
          ).isError,
        ).toBe(true);
        expect(backend.calls).toHaveLength(before);
        expect(
          (
            await client.callTool({
              name: 'shieldlabs_patch_webhook',
              arguments: {
                domain_id: DOMAIN_ID,
                webhook_id: HOOK_ID,
                url: 'https://example.com/new',
                confirm: true,
              },
            })
          ).isError,
        ).not.toBe(true);
        expect(backend.calls.at(-1)!.body).toBe('{"url":"https://example.com/new"}');
      } finally {
        await client.close();
      }
    });

    it('normalizes history, summarizes and explains risk, preserves domain selection and isolates accounts', async () => {
      const backend = operationsBackend();
      const instance = host(backend);
      const first = await connect(instance);
      const second = await connect(instance, SECOND_TOKEN);
      try {
        const search = {
          name: 'shieldlabs_search_history',
          arguments: { type: 'user_hid', value: 'user+%? #', response_format: 'json' },
        };
        const [a, b] = await Promise.all([first.callTool(search), second.callTool(search)]);
        expect(a.isError).not.toBe(true);
        expect(b.isError).not.toBe(true);
        expect(JSON.stringify(a.structuredContent)).toContain('example.com');
        expect(JSON.stringify(a.structuredContent)).not.toContain('other.test');
        expect(JSON.stringify(b.structuredContent)).toContain('other.test');
        expect(backend.calls.some((call) => call.path.includes('/user%2B%25%3F%20%23?'))).toBe(
          true,
        );
        const get = await first.callTool({
          name: 'shieldlabs_get_identification',
          arguments: { request_id: REQUEST_ID, domain: 'example.com', wait: false },
        });
        expect(get.isError).not.toBe(true);
        expect(get.structuredContent).toMatchObject({ found: true });
        expect(backend.calls.at(-1)!.path).toContain(
          `/requests/${REQUEST_ID}?limit=1&offset=0&domain=example.com`,
        );
        const summary = await first.callTool({
          name: 'shieldlabs_summarize_entity',
          arguments: { type: 'user_hid', value: 'user', max_items: 1 },
        });
        expect(summary.isError).not.toBe(true);
        expect(summary.structuredContent).toMatchObject({
          window: { identifications_analyzed: 1 },
        });
        const explanation = await first.callTool({
          name: 'shieldlabs_explain_risk_score',
          arguments: { request_id: REQUEST_ID, domain: 'example.com' },
        });
        expect(explanation.isError).not.toBe(true);
        expect(explanation.structuredContent).toHaveProperty('signals');
        expect(
          (
            await first.readResource({
              uri: `shieldlabs://domains/example.com/identifications/${REQUEST_ID}`,
            })
          ).contents,
        ).toHaveLength(1);
        backend.setMultiple(true);
        const missing = await first.callTool(search);
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing.content)).toContain('domain_required');
        expect(JSON.stringify(missing.content)).toContain('example.com');
        const foreign = await first.callTool({
          ...search,
          arguments: { ...search.arguments, domain: 'other.test' },
        });
        expect(foreign.isError).toBe(true);
        expect(JSON.stringify(foreign.content)).toContain('unknown_domain');
      } finally {
        await Promise.all([first.close(), second.close()]);
      }
    });

    it('sanitizes errors, propagates rate limits, and never retries mutations', async () => {
      const backend = operationsBackend();
      const instance = host(backend);
      const client = await connect(instance);
      try {
        for (const [status, code] of [
          [400, 'invalid_request'],
          [404, 'not_found'],
          [409, 'conflict'],
          [500, 'unavailable'],
          [429, 'rate_limited'],
        ] as const) {
          backend.force({
            status,
            body: { error: RAW_KEY, debug: RAW_SECRET },
            headers: { 'retry-after': '1' },
          });
          const before = backend.calls.length;
          const reply = await client.callTool({
            name: 'shieldlabs_create_domain',
            arguments: { domain: 'example.com' },
          });
          expect(reply.isError).toBe(true);
          expect(JSON.stringify(reply.content)).toContain(code);
          expect(JSON.stringify(reply)).not.toContain(RAW_KEY);
          expect(JSON.stringify(reply)).not.toContain(RAW_SECRET);
          expect(backend.calls).toHaveLength(before + 1);
        }
        backend.force(undefined);
        backend.revoked.add(HOSTED_TOKEN);
        expect(
          (await client.callTool({ name: 'shieldlabs_list_domains', arguments: {} })).isError,
        ).toBe(true);
        expect(JSON.stringify(instance.logs)).not.toContain(RAW_KEY);
      } finally {
        await client.close();
      }
    });
  });
}
