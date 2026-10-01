import type { FetchLike, FetchRequestInit } from '@shieldlabs-ai/node';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from '../src/constants.js';
import { IDENTIFICATION_SCHEMA, WEBHOOK_EVENT_SCHEMA } from '../src/resources/schemas.js';
import {
  callJson,
  callTool,
  connect,
  fixture,
  FULL_ENV,
  MANAGEMENT_BASE,
  MOCK_DOMAIN,
  MOCK_SECRET_KEY,
  mockApiFetch,
  statusFetch,
  textOf,
  type Connected,
} from './helpers.js';

let connected: Connected | undefined;

afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const profileExpected = fixture('management-profile-expected.json');
const errors = fixture<{ cases: any[] }>('error-responses.json').cases;

function managementError(status: number) {
  const chosen = errors.find((c) => c.surface === 'management' && c.status === status);
  return statusFetch(chosen.status, chosen.body, chosen.content_type);
}

/** A Management API whose answers wait until release() (or until the request is aborted). */
function heldProfileFetch() {
  const calls: FetchRequestInit[] = [];
  const held: ((response: Response) => void)[] = [];
  const fetch = vi.fn((_url: string, init: FetchRequestInit) => {
    calls.push(init);
    return new Promise<Response>((resolve, reject) => {
      held.push(resolve);
      init.signal.addEventListener('abort', () => reject(init.signal.reason as Error), {
        once: true,
      });
    });
  });
  const release = (): void => {
    for (const resolve of held.splice(0)) {
      resolve(
        new Response(JSON.stringify(fixture('management-profile.json')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
  };
  return { fetch: fetch as unknown as FetchLike, calls, release };
}

describe('shieldlabs_get_domain_profile', () => {
  it('returns the profile and caches it for 60 seconds', async () => {
    const api = mockApiFetch();
    let now = Date.parse('2026-09-30T12:00:00.000Z');
    connected = await connect(FULL_ENV, { apiFetch: api.fetch, now: () => now });
    const first = await callJson(connected.client, TOOL_NAMES.getDomainProfile);
    expect(first).toEqual({
      ...profileExpected,
      fetched_at: '2026-09-30T12:00:00.000Z',
      from_cache: false,
    });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.url).toBe(`${MANAGEMENT_BASE}/v1/profile`);
    expect(api.calls[0]!.init.headers['X-Shield-Domain']).toBe(MOCK_DOMAIN);
    expect(api.calls[0]!.init.headers.Authorization).toBe(`Bearer ${MOCK_SECRET_KEY}`);

    now += 30_000;
    const cached = await callJson(connected.client, TOOL_NAMES.getDomainProfile);
    expect(cached.from_cache).toBe(true);
    expect(api.calls).toHaveLength(1);

    now += 31_000;
    const refreshed = textOf(await callTool(connected.client, TOOL_NAMES.getDomainProfile));
    expect(api.calls).toHaveLength(2);
    expect(refreshed).toContain('Remaining included identifications: 148,230');
    expect(refreshed).toContain('caches the profile for 60 s');
    expect(refreshed).not.toContain(MOCK_SECRET_KEY);
  });

  it('shares one Management API request between concurrent calls', async () => {
    const api = heldProfileFetch();
    connected = await connect(FULL_ENV, { apiFetch: api.fetch });
    const { client, ctx } = connected;
    const pending = [1, 2, 3].map(() => callJson(client, TOOL_NAMES.getDomainProfile));
    await vi.waitFor(() => expect(ctx.profileRequest?.waiters).toBe(3));
    expect(api.calls).toHaveLength(1);
    api.release();
    const results = await Promise.all(pending);
    expect(results.map((r) => r.domain)).toEqual(['example.com', 'example.com', 'example.com']);
    expect(api.calls).toHaveLength(1);
    expect(ctx.profileRequest).toBeUndefined();
  });

  it('keeps the shared request for the remaining calls when one is cancelled', async () => {
    const api = heldProfileFetch();
    let now = Date.parse('2026-09-30T12:00:00.000Z');
    connected = await connect(FULL_ENV, { apiFetch: api.fetch, now: () => now });
    const { client, ctx } = connected;
    const cancelled = new AbortController();
    const first = client.callTool({ name: TOOL_NAMES.getDomainProfile, arguments: {} }, undefined, {
      signal: cancelled.signal,
    });
    const second = callJson(client, TOOL_NAMES.getDomainProfile);
    await vi.waitFor(() => expect(ctx.profileRequest?.waiters).toBe(2));
    cancelled.abort();
    await expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(ctx.profileRequest?.waiters).toBe(1));
    expect(api.calls[0]!.signal.aborted).toBe(false);
    api.release();
    expect((await second).domain).toBe('example.com');

    // When every waiting call is cancelled, the request itself is aborted.
    now += 61_000;
    const alone = new AbortController();
    const third = client.callTool({ name: TOOL_NAMES.getDomainProfile, arguments: {} }, undefined, {
      signal: alone.signal,
    });
    await vi.waitFor(() => expect(ctx.profileRequest?.waiters).toBe(1));
    alone.abort();
    await expect(third).rejects.toThrow();
    await vi.waitFor(() => expect(api.calls[1]!.signal.aborted).toBe(true));
    expect(ctx.profileRequest).toBeUndefined();
  });

  it('answers from memory during the 10-minute block after a 429', async () => {
    const api = managementError(429);
    let now = Date.parse('2026-09-30T12:00:00.000Z');
    connected = await connect(FULL_ENV, { apiFetch: api.fetch, now: () => now });
    const first = await callTool(connected.client, TOOL_NAMES.getDomainProfile);
    expect(first.isError).toBe(true);
    expect(textOf(first)).toContain('Wait at least 10 minutes');

    now += 60_000;
    const second = await callTool(connected.client, TOOL_NAMES.getDomainProfile);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toContain(
      'does not call it again before 2026-09-30 12:10:00 UTC (in about 9 minutes)',
    );
    expect(api.calls).toHaveLength(1);

    now += 9 * 60_000;
    await callTool(connected.client, TOOL_NAMES.getDomainProfile);
    expect(api.calls).toHaveLength(2);
  });

  it('marks a negative balance', async () => {
    connected = await connect(FULL_ENV, {
      apiFetch: statusFetch(
        200,
        JSON.stringify({
          Domain: 'example.com',
          Weight: -120,
          PublicKey: '',
          Secret: '',
          CreatedAt: '2026-01-15T09:00:00Z',
        }),
      ).fetch,
    });
    const text = textOf(await callTool(connected.client, TOOL_NAMES.getDomainProfile));
    expect(text).toContain('-120 (negative: the account is over its included volume)');
  });

  it('maps Management API errors to actionable messages', async () => {
    const expectations: [number, string][] = [
      [401, 'SHIELDLABS_DOMAIN is exactly the registered domain'],
      [429, 'Wait at least 10 minutes'],
      [402, 'no identifications left'],
      [503, 'server error (HTTP 503)'],
      [404, 'SHIELDLABS_MANAGEMENT_BASE_URL must be the origin only'],
      [400, 'answered HTTP 400'],
    ];
    for (const [status, message] of expectations) {
      const api = managementError(status);
      connected = await connect(FULL_ENV, { apiFetch: api.fetch });
      const result = await callTool(connected.client, TOOL_NAMES.getDomainProfile);
      expect(result.isError, String(status)).toBe(true);
      expect(textOf(result)).toContain(message);
      expect(textOf(result)).not.toContain(MOCK_SECRET_KEY);
      if (status === 429) expect(api.calls).toHaveLength(1);
      await connected.close();
      connected = undefined;
    }
  });
});

describe('resources', () => {
  it('serves the contract schemas and the reference catalog', async () => {
    connected = await connect();
    const schema = await connected.client.readResource({
      uri: 'shieldlabs://contract/identification',
    });
    expect(schema.contents[0]).toMatchObject({ mimeType: 'application/schema+json' });
    expect(JSON.parse((schema.contents[0] as any).text).title).toBe('Identification');
    const webhook = await connected.client.readResource({
      uri: 'shieldlabs://contract/webhook-event',
    });
    expect((webhook.contents[0] as any).text).toContain('X-Shield-Signature');
    const signals = JSON.parse(
      (
        (await connected.client.readResource({ uri: 'shieldlabs://reference/risk-signals' }))
          .contents[0] as any
      ).text,
    );
    expect(signals.risk_signals.map((s: any) => s.slug)).toContain('antidetect_browser');
    expect(signals.detection_flags).toHaveLength(19);
    expect(signals.connection_types).toHaveLength(8);
    expect(signals.notes.join(' ')).toContain('can change');
    const bands = JSON.parse(
      (
        (await connected.client.readResource({ uri: 'shieldlabs://reference/risk-bands' }))
          .contents[0] as any
      ).text,
    );
    expect(bands.bands.map((b: any) => [b.band, b.min, b.max])).toEqual([
      ['trusted', 0, 29],
      ['suspicious', 30, 59],
      ['dangerous', 60, 100],
    ]);
    expect(bands.rate_limit_marker.meaning).toContain('999');
  });

  it('reads an identification through the resource template', async () => {
    connected = await connect(FULL_ENV, {
      apiFetch: mockApiFetch({ rows: fixture('history-page.json').data, profile: {} }).fetch,
    });
    const found = await connected.client.readResource({
      uri: 'shieldlabs://identifications/a5b7c9d1-e3f5-4a7b-9c1d-3e5f7a9b1c3d',
    });
    const item = JSON.parse((found.contents[0] as any).text);
    expect(item).toMatchObject({
      request_id: 'a5b7c9d1-e3f5-4a7b-9c1d-3e5f7a9b1c3d',
      risk_score: 80,
      risk_band: 'dangerous',
    });
    await expect(
      connected.client.readResource({
        uri: 'shieldlabs://identifications/11111111-2222-4333-8444-555555555555',
      }),
    ).rejects.toThrow(/No identification with request ID/);
    await expect(
      connected.client.readResource({ uri: 'shieldlabs://identifications/nope' }),
    ).rejects.toThrow(/must be a UUID/);
  });

  it('reports API errors when reading the template', async () => {
    connected = await connect(FULL_ENV, {
      apiFetch: statusFetch(401, '{"error":"invalid api key"}\n', 'text/plain').fetch,
    });
    await expect(
      connected.client.readResource({
        uri: 'shieldlabs://identifications/a5b7c9d1-e3f5-4a7b-9c1d-3e5f7a9b1c3d',
      }),
    ).rejects.toThrow(/rejected the key/);
  });
});

describe('JSON Schemas', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });

  it('validate tool outputs against the Identification schema', async () => {
    const validate = ajv.compile(IDENTIFICATION_SCHEMA);
    connected = await connect(FULL_ENV, {
      apiFetch: mockApiFetch({ rows: fixture('history-page.json').data, profile: {} }).fetch,
    });
    const page = await callJson(connected.client, TOOL_NAMES.searchHistory, {
      type: 'user_hid',
      value: 'anonymous',
    });
    for (const item of page.identifications) {
      expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
    }
    for (const testCase of fixture<{ cases: any[] }>('normalization-cases.json').cases) {
      expect(validate(testCase.expected), testCase.name).toBe(true);
    }
  });

  it('validate every webhook fixture, including the Test delivery with 17 flags', () => {
    const validate = ajv.compile(WEBHOOK_EVENT_SCHEMA);
    for (const name of [
      'webhook-identification-scored.json',
      'webhook-rate-limited.json',
      'webhook-ping.json',
      'webhook-test-delivery.json',
    ]) {
      expect(validate(fixture(name)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    const testDelivery = fixture('webhook-test-delivery.json');
    expect(Object.keys(testDelivery.data.detection_flags)).toHaveLength(17);
    expect(
      validate({
        ...testDelivery,
        data: { ...testDelivery.data, detection_flags: { vpn: 'yes' } },
      }),
    ).toBe(false);
    expect(
      validate({
        event_type: 'identification.scored',
        schema_version: '2026-06-01',
        created_at: 'x',
      }),
    ).toBe(false);
  });
});
