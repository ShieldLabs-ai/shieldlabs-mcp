import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64Url, hmacSha256Base64Url, sha256Hex } from '../src/public/digest.js';
import {
  GATEWAY_HEADER,
  gatewayHeader,
  newNonce,
  NONCE_BYTES,
  requestUriOf,
} from '../src/public/gateway.js';
import { pingPortal } from '../src/public/portal.js';
import { answerFetch, PUBLIC_CONFIG, verifyGateway } from './public-helpers.js';

// The test vector of the gateway signature in the ShieldLabs API (docs/mcp-auth.md there,
// TestMCPGatewayHeaderVector): the API verifies exactly this value.
const VECTOR = {
  secret: 'gateway-test-secret-0123456789abcdef',
  kid: 'k1',
  token: `slat_${'A'.repeat(43)}`,
  method: 'GET',
  requestUri: '/mcp/v1/ping',
  unixSeconds: 1_790_000_000,
  nonce: 'n0nce-0123456789abc',
  header:
    'v1 kid=k1 t=1790000000 n=n0nce-0123456789abc sig=7ohH7Tn_ukcku1N-mH7zjq7TYIkEIeB6Jml3oV3smzU',
};

describe('digests', () => {
  it('match node:crypto for SHA-256, HMAC-SHA256 and base64url', async () => {
    for (const text of ['', 'abc', 'naïve ✓ 日本', 'x'.repeat(10_000)]) {
      expect(await sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
      expect(await hmacSha256Base64Url('key ✓', text)).toBe(
        createHmac('sha256', 'key ✓').update(text).digest('base64url'),
      );
    }
    const bytes = new Uint8Array([0, 255, 250, 251, 62, 63, 1]);
    expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });
});

describe('gateway signature', () => {
  it('reproduces the test vector of the ShieldLabs API', async () => {
    const header = await gatewayHeader(
      { kid: VECTOR.kid, secret: VECTOR.secret },
      {
        method: VECTOR.method,
        requestUri: VECTOR.requestUri,
        tokenHash: await sha256Hex(VECTOR.token),
        unixSeconds: VECTOR.unixSeconds,
        nonce: VECTOR.nonce,
      },
    );
    expect(header).toBe(VECTOR.header);
  });

  it('sends exactly the vector on a ping with that key, time and nonce', async () => {
    const portal = answerFetch(200, '{"status":"ok"}');
    const result = await pingPortal(VECTOR.token, await sha256Hex(VECTOR.token), {
      config: { ...PUBLIC_CONFIG, gatewayKey: { kid: VECTOR.kid, secret: VECTOR.secret } },
      fetch: portal.fetch,
      now: () => VECTOR.unixSeconds * 1000 + 999,
      nonce: () => VECTOR.nonce,
    });
    expect(result).toEqual({ outcome: 'ok' });
    expect(portal.calls[0]!.init.headers[GATEWAY_HEADER]).toBe(VECTOR.header);
  });

  it('covers the time, the nonce, the method, the request URI and the token', async () => {
    const key = { kid: VECTOR.kid, secret: VECTOR.secret };
    const base = {
      method: VECTOR.method,
      requestUri: VECTOR.requestUri,
      tokenHash: await sha256Hex(VECTOR.token),
      unixSeconds: VECTOR.unixSeconds,
      nonce: VECTOR.nonce,
    };
    const variants = [
      { ...base, unixSeconds: base.unixSeconds + 1 },
      { ...base, nonce: 'n0nce-0123456789abd' },
      { ...base, method: 'POST' },
      { ...base, requestUri: '/mcp/v1/ping?x=1' },
      { ...base, tokenHash: await sha256Hex(`slat_${'B'.repeat(43)}`) },
    ];
    const signatures = new Set(
      await Promise.all(
        variants.map(async (variant) => (await gatewayHeader(key, variant)).split('sig=')[1]),
      ),
    );
    expect(signatures.size).toBe(variants.length);
    expect(signatures.has(VECTOR.header.split('sig=')[1])).toBe(false);
  });

  it('signs the path and query exactly as sent, without the origin', () => {
    expect(requestUriOf('https://account.example.test/mcp/v1/ping')).toBe('/mcp/v1/ping');
    expect(requestUriOf('http://127.0.0.1:8090/mcp/v1/ping?a=1&b=%20')).toBe(
      '/mcp/v1/ping?a=1&b=%20',
    );
  });
});

describe('nonces', () => {
  it('are 16 random bytes in 22 base64url characters, never repeated', () => {
    expect(NONCE_BYTES).toBe(16);
    const nonces = Array.from({ length: 2_000 }, () => newNonce());
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('are fresh on every ping, so the ShieldLabs API never sees a replay', async () => {
    const portal = answerFetch(200, '{"status":"ok"}');
    const deps = { config: PUBLIC_CONFIG, fetch: portal.fetch, now: () => 1_790_000_000_000 };
    const hash = await sha256Hex(VECTOR.token);
    for (let i = 0; i < 5; i++) await pingPortal(VECTOR.token, hash, deps);
    const headers = portal.calls.map((call) => call.init.headers[GATEWAY_HEADER]!);
    const seen = new Set<string>();
    for (const header of headers) {
      expect(
        verifyGateway(header, {
          method: 'GET',
          requestUri: '/mcp/v1/ping',
          token: VECTOR.token,
          nowMs: 1_790_000_000_000,
          seen,
        }),
      ).toBeUndefined();
    }
    expect(new Set(headers.map((header) => header.match(/ n=(\S+) /)![1])).size).toBe(5);
    // The same header sent twice is a replay.
    expect(
      verifyGateway(headers[0], {
        method: 'GET',
        requestUri: '/mcp/v1/ping',
        token: VECTOR.token,
        nowMs: 1_790_000_000_000,
        seen,
      }),
    ).toBe('gateway_replayed');
  });
});
