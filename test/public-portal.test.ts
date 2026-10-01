import { describe, expect, it, vi } from 'vitest';
import { SERVER_VERSION } from '../src/constants.js';
import { GATEWAY_HEADER } from '../src/public/gateway.js';
import {
  checkToken,
  PING_TIMEOUT_MS,
  pingPortal,
  type PingDependencies,
  type PortalFetch,
} from '../src/public/portal.js';
import {
  bearerToken,
  isAccessToken,
  MAX_CACHED_TOKENS,
  TOKEN_CACHE_TTL_MS,
  TokenCache,
} from '../src/public/token.js';
import {
  answerFetch,
  fakePortal,
  NOW,
  OTHER_TOKEN,
  PUBLIC_CONFIG,
  sha256,
  TOKEN,
} from './public-helpers.js';

function deps(fetch: PortalFetch, now = () => NOW): PingDependencies {
  return { config: PUBLIC_CONFIG, fetch, now };
}

describe('access tokens', () => {
  it('accept only slat_ and 43 base64url characters', () => {
    expect(isAccessToken(TOKEN)).toBe(true);
    expect(isAccessToken(OTHER_TOKEN)).toBe(true);
    for (const value of [
      `slat_${'A'.repeat(42)}`,
      `slat_${'A'.repeat(44)}`,
      `slat_${'A'.repeat(42)}=`,
      `slrt_${'A'.repeat(43)}`,
      `slk_${'A'.repeat(43)}`,
      'sec_abcd1234-efgh5678-ijkl9012',
      'eyJhbGciOiJIUzI1NiJ9.e30.x',
      `${TOKEN} ${TOKEN}`,
      '',
    ]) {
      expect(isAccessToken(value), value).toBe(false);
    }
  });

  it('come from an Authorization: Bearer header only', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`  bearer   ${TOKEN}  `)).toBe(TOKEN);
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
    expect(bearerToken(null)).toBeUndefined();
  });
});

describe('ping of the ShieldLabs API', () => {
  it('sends GET /mcp/v1/ping with the token and a valid signature, without following redirects', async () => {
    const portal = fakePortal();
    expect(await pingPortal(TOKEN, sha256(TOKEN), deps(portal.fetch))).toEqual({ outcome: 'ok' });
    const [call] = portal.calls;
    expect(call!.url).toBe('https://account.example.test/mcp/v1/ping');
    expect(call!.init.method).toBe('GET');
    expect(call!.init.redirect).toBe('manual');
    expect(call!.init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': `shieldlabs-mcp/${SERVER_VERSION}`,
    });
    expect(call!.init.headers[GATEWAY_HEADER]).toMatch(
      /^v1 kid=k1 t=1790856000 n=[A-Za-z0-9_-]{22} sig=[A-Za-z0-9_-]{43}$/,
    );
  });

  it('maps every answer of the guard', async () => {
    const cases: [number, string, unknown][] = [
      [200, '{"status":"ok"}', { outcome: 'ok' }],
      [200, '{"status":"degraded"}', { outcome: 'unexpected', status: 200 }],
      [200, '<html>', { outcome: 'unexpected', status: 200 }],
      [401, '{"error":"invalid_token"}', { outcome: 'invalid_token' }],
      [
        401,
        '{"error":"invalid_gateway_signature","reason":"gateway_stale"}',
        { outcome: 'gateway_rejected', reason: 'gateway_stale' },
      ],
      [
        401,
        '{"error":"invalid_gateway_signature","reason":"gateway_replayed"}',
        { outcome: 'gateway_rejected', reason: 'gateway_replayed' },
      ],
      [
        401,
        '{"error":"invalid_gateway_signature","reason":"<script>"}',
        { outcome: 'gateway_rejected', reason: 'gateway_unknown' },
      ],
      [401, 'Unauthorized', { outcome: 'unexpected', status: 401 }],
      [503, '{"error":"temporarily_unavailable"}', { outcome: 'unavailable', status: 503 }],
      [500, '{"error":"server_error"}', { outcome: 'unavailable', status: 500 }],
      [502, 'Bad gateway', { outcome: 'unavailable', status: 502 }],
      [404, 'not found', { outcome: 'unexpected', status: 404 }],
      [302, '', { outcome: 'unexpected', status: 302 }],
      [429, '{}', { outcome: 'unexpected', status: 429 }],
    ];
    for (const [status, body, expected] of cases) {
      const result = await pingPortal(TOKEN, sha256(TOKEN), deps(answerFetch(status, body).fetch));
      expect(result, `${status} ${body}`).toEqual(expected);
    }
  });

  it('reports network errors as unavailable', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('connect ECONNREFUSED')));
    expect(await pingPortal(TOKEN, sha256(TOKEN), deps(failing))).toEqual({
      outcome: 'unavailable',
    });
  });

  it('gives the ShieldLabs API 3 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reached!: () => void;
      const called = new Promise<void>((resolve) => (reached = resolve));
      const hanging = vi.fn((_url: string, init: { signal: AbortSignal }) => {
        reached();
        return new Promise<never>((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const pending = pingPortal(TOKEN, sha256(TOKEN), deps(hanging));
      await called;
      expect(PING_TIMEOUT_MS).toBe(3_000);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(hanging.mock.calls[0]![1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ outcome: 'unavailable' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is accepted by the guard only within 60 seconds of its clock', async () => {
    for (const [skew, accepted] of [
      [-61_000, false],
      [-60_000, true],
      [60_000, true],
      [61_000, false],
    ] as const) {
      const portal = fakePortal({ now: () => NOW + skew });
      const result = await pingPortal(TOKEN, sha256(TOKEN), deps(portal.fetch));
      expect(result, String(skew)).toEqual(
        accepted ? { outcome: 'ok' } : { outcome: 'gateway_rejected', reason: 'gateway_stale' },
      );
    }
  });
});

describe('token cache', () => {
  it('remembers an accepted token for 60 seconds by its hash', () => {
    const cache = new TokenCache();
    expect(TOKEN_CACHE_TTL_MS).toBe(60_000);
    const hash = sha256(TOKEN);
    expect(cache.has(hash, NOW)).toBe(false);
    cache.remember(hash, NOW);
    expect(cache.has(hash, NOW + 59_999)).toBe(true);
    expect(cache.has(hash, NOW + 60_000)).toBe(false);
    expect(cache.size).toBe(0);
    cache.remember(hash, NOW);
    cache.forget(hash);
    expect(cache.has(hash, NOW)).toBe(false);
  });

  it('keeps at most 1000 tokens and drops the least recently used first', () => {
    expect(MAX_CACHED_TOKENS).toBe(1_000);
    const cache = new TokenCache(60_000, 3);
    for (const name of ['a', 'b', 'c']) cache.remember(name, NOW);
    expect(cache.has('a', NOW)).toBe(true);
    cache.remember('d', NOW);
    expect(cache.size).toBe(3);
    expect(cache.has('b', NOW)).toBe(false);
    expect(cache.has('a', NOW)).toBe(true);
  });

  it('caches only accepted tokens and never asks for a cached one', async () => {
    let now = NOW;
    const portal = fakePortal({ tokens: [TOKEN], now: () => now });
    const pingDeps = deps(portal.fetch, () => now);
    const cache = new TokenCache();
    const mayPing = vi.fn(async () => true);
    const check = (token: string) => checkToken(token, sha256(token), cache, pingDeps, mayPing);

    expect(await check(TOKEN)).toEqual({ outcome: 'ok', cached: false });
    expect(await check(TOKEN)).toEqual({ outcome: 'ok', cached: true });
    now += 59_000;
    expect(await check(TOKEN)).toEqual({ outcome: 'ok', cached: true });
    now += 1_000;
    expect(await check(TOKEN)).toEqual({ outcome: 'ok', cached: false });
    expect(portal.calls).toHaveLength(2);
    expect(mayPing).toHaveBeenCalledTimes(2);

    // Refusals are asked again every time.
    expect(await check(OTHER_TOKEN)).toEqual({ outcome: 'invalid_token' });
    expect(await check(OTHER_TOKEN)).toEqual({ outcome: 'invalid_token' });
    portal.setDown(true);
    now += 61_000;
    expect(await check(TOKEN)).toEqual({ outcome: 'unavailable', status: 503 });
    expect(await check(TOKEN)).toEqual({ outcome: 'unavailable', status: 503 });
    expect(portal.calls).toHaveLength(6);
    expect(cache.size).toBe(0);
  });

  it('does not ping when the per-address limit refuses', async () => {
    const portal = fakePortal();
    const cache = new TokenCache();
    const result = await checkToken(TOKEN, sha256(TOKEN), cache, deps(portal.fetch), async () =>
      Promise.resolve(false),
    );
    expect(result).toEqual({ outcome: 'throttled' });
    expect(portal.calls).toHaveLength(0);
  });
});
