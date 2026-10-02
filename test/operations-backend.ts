import history from './fixtures/history-page.json';
import type { PortalFetch } from '../src/public/portal.js';

export const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
export const HOOK_ID = '22222222-2222-4222-8222-222222222222';
export const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
export const HOSTED_TOKEN = `slat_${'A'.repeat(43)}`;
export const SECOND_TOKEN = `slat_${'B'.repeat(43)}`;
export const RAW_KEY = 'sec_abcd1234-efgh5678-ijkl9012';
export const RAW_SECRET = 'whsec_private_test_value';
export const SIGNING_SECRET = 'gateway-test-secret-0123456789abcdef';
export const DOMAIN_PATH = `/mcp/v1/domains/${DOMAIN_ID}`;
export const HOOK_PATH = `${DOMAIN_PATH}/webhooks/${HOOK_ID}`;
export const UPSTREAM = 'https://account.example.test';

const encoder = new TextEncoder();
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Independent verifier: no imports of production signing code. */
export async function verifyRequest(url: URL, init: Parameters<PortalFetch>[1], seen: Set<string>) {
  const header = init.headers['X-Shield-Gateway'] ?? '';
  const match = /^(v[12]) kid=k1 t=(\d+) n=([A-Za-z0-9_-]{16,64}) sig=([A-Za-z0-9_-]+)$/.exec(
    header,
  );
  if (match === null) throw new Error('Invalid signature header');
  const [, version, time, nonce, signature] = match;
  if (init.method !== 'GET' && version !== 'v2') throw new Error('Mutation requires v2');
  if (Math.abs(Number(time) - Math.floor(Date.now() / 1000)) > 60)
    throw new Error('Stale signature');
  const token = init.headers.Authorization?.replace(/^Bearer /, '') ?? '';
  const parts = [
    version,
    time,
    nonce,
    init.method,
    `${url.pathname}${url.search}`,
    await hash(token),
  ];
  if (version === 'v2') parts.push(await hash(init.body ?? ''));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(parts.join('\n'))),
  );
  const expected = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  if (signature !== expected) throw new Error('Signature mismatch');
  if (seen.has(nonce!)) throw new Error('Replayed nonce');
  seen.add(nonce!);
  return token;
}

export function operationsBackend() {
  const calls: {
    path: string;
    method: string;
    body: string;
    token: string;
    init: Parameters<PortalFetch>[1];
  }[] = [];
  const seen = new Set<string>();
  const revoked = new Set<string>();
  let forced: { status: number; body: unknown; headers?: Record<string, string> } | undefined;
  let multiple = false;
  const failures: number[] = [];
  const domain = (token: string, secret = false) => ({
    id: DOMAIN_ID,
    domain: token === SECOND_TOKEN ? 'other.test' : 'example.com',
    enabled: true,
    allow_subdomains: true,
    domain_verified: true,
    public_key: 'pub_installation',
    server_key: secret ? RAW_KEY : '********',
    created_at: '2026-10-02T12:00:00Z',
  });
  const hook = (secret = false) => ({
    id: HOOK_ID,
    name: 'Production',
    url: 'https://example.com/hook',
    enabled: true,
    status: 'active',
    secret: secret ? RAW_SECRET : '********',
    created_at: '2026-10-02T12:00:00Z',
    updated_at: '2026-10-02T12:00:00Z',
    requests: 1,
    last_delivery_at: null,
  });
  const fetch: PortalFetch = async (address, init) => {
    const url = new URL(address);
    if (url.origin !== UPSTREAM || !url.pathname.startsWith('/mcp/v1/'))
      throw new Error('Wrong contour');
    const token = await verifyRequest(url, init, seen);
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: init.method,
      body: init.body ?? '',
      token,
      init,
    });
    if (revoked.has(token)) return Response.json({ error: 'invalid_token' }, { status: 401 });
    if (url.pathname === '/mcp/v1/ping') return Response.json({ status: 'ok' });
    const failure = failures.shift();
    if (failure !== undefined)
      return Response.json(
        { code: 'temporarily_unavailable' },
        { status: failure, headers: { 'retry-after': '1' } },
      );
    if (forced !== undefined)
      return Response.json(forced.body, {
        status: forced.status,
        ...(forced.headers === undefined ? {} : { headers: forced.headers }),
      });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/mcp/v1/domains' && init.method === 'GET')
      return Response.json({ domains: [domain(token)] });
    if (url.pathname === '/mcp/v1/domains' || url.pathname.endsWith('/server-key/rotate'))
      return Response.json(domain(token, true), {
        status: url.pathname === '/mcp/v1/domains' ? 201 : 200,
      });
    if (url.pathname === DOMAIN_PATH) return Response.json(domain(token));
    if (url.pathname === `${DOMAIN_PATH}/webhooks`)
      return Response.json(init.method === 'GET' ? { webhooks: [hook()] } : hook(true), {
        status: init.method === 'GET' ? 200 : 201,
      });
    if (url.pathname.endsWith('/test'))
      return Response.json({
        delivered: false,
        status_code: 503,
        latency_ms: 10,
        timed_out: false,
      });
    if (url.pathname.startsWith(`${DOMAIN_PATH}/webhooks/`))
      return Response.json(hook(url.pathname.endsWith('/rotate-secret')));
    if (/^\/mcp\/v1\/(history|requests)\//.test(url.pathname)) {
      const want = url.searchParams.get('domain');
      const owned = token === SECOND_TOKEN ? 'other.test' : 'example.com';
      if ((multiple && want === null) || (want !== null && want !== owned))
        return Response.json(
          {
            code: want === null ? 'domain_required' : 'unknown_domain',
            error: 'pass an enabled domain',
            domains: [owned, ...(multiple ? ['second.test'] : [])],
          },
          { status: want === null ? 400 : 404 },
        );
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      const rows = history.data.map((row) => ({ ...row, request_id: REQUEST_ID, domain: owned }));
      return Response.json({ data: rows.slice(offset, offset + limit), total: rows.length });
    }
    return Response.json({ code: 'not_found' }, { status: 404 });
  };
  return {
    fetch,
    calls,
    seen,
    revoked,
    failNext: (status: number) => {
      failures.push(status);
    },
    setMultiple: (value: boolean) => {
      multiple = value;
    },
    force: (value: typeof forced) => {
      forced = value;
    },
  };
}
