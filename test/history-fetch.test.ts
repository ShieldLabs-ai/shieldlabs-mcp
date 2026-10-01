import type { FetchLike, FetchRequestInit, FetchResponseLike } from '@shieldlabs-ai/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServerConfig } from '../src/config.js';
import { TOOL_NAMES } from '../src/constants.js';
import { createContext } from '../src/context.js';
import {
  budgetedHistoryFetch,
  DEFAULT_HISTORY_BUDGET,
  MAX_RATE_LIMIT_PAUSE_MS,
  RATE_LIMIT_PAUSE_MS,
} from '../src/history-fetch.js';
import { callTool, connect, FULL_ENV, mockApiFetch, textOf, type Connected } from './helpers.js';

let connected: Connected | undefined;

afterEach(async () => {
  await connected?.close();
  connected = undefined;
  vi.useRealTimers();
});

const BASE = 'https://account.example.test/api/v1/history';

interface PendingCall {
  url: string;
  init: FetchRequestInit;
  startedAt: number;
  respond(status?: number, headers?: Record<string, string>): void;
}

/** A fetch that records calls and answers only when the test says so. */
function controlledFetch(clock: () => number) {
  const calls: PendingCall[] = [];
  const fetch = vi.fn(
    (url: string, init: FetchRequestInit) =>
      new Promise<FetchResponseLike>((resolve) => {
        calls.push({
          url,
          init,
          startedAt: clock(),
          respond: (status = 200, headers = {}) =>
            resolve(
              new Response(status === 200 ? '{"data":[],"total":0}' : '{"error":"x"}', {
                status,
                headers,
              }),
            ),
        });
      }),
  );
  return { fetch: fetch as unknown as FetchLike, calls };
}

function init(signal = new AbortController().signal): FetchRequestInit {
  return { method: 'GET', headers: {}, signal };
}

describe('History request budget', () => {
  it('keeps the documented default: 2 in flight, 5 per second', () => {
    expect(DEFAULT_HISTORY_BUDGET).toEqual({ maxConcurrent: 2, perSecond: 5 });
  });

  it('runs at most maxConcurrent requests at once and starts at most perSecond per second', async () => {
    vi.useFakeTimers();
    const clock = () => Date.now();
    const api = controlledFetch(clock);
    const fetch = budgetedHistoryFetch(api.fetch, { maxConcurrent: 2, perSecond: 5 }, clock);
    const started = Date.now();
    const results = Array.from({ length: 5 }, (_, index) =>
      fetch(`${BASE}/ip/203.0.113.${index}`, init()),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(2);
    // Two in flight: the third waits for a free slot even though its time has come.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.calls).toHaveLength(2);
    api.calls[0]!.respond();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls).toHaveLength(3);
    api.calls[1]!.respond();
    api.calls[2]!.respond();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(4);
    api.calls[3]!.respond();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(5);
    api.calls[4]!.respond();
    expect((await Promise.all(results)).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const starts = api.calls.map((call) => call.startedAt - started);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(200);
    }
  });

  it('pauses every queued request after a 429, honouring Retry-After within bounds', async () => {
    vi.useFakeTimers();
    const clock = () => Date.now();
    const api = controlledFetch(clock);
    const fetch = budgetedHistoryFetch(api.fetch, { maxConcurrent: 1, perSecond: 1000 }, clock);
    const first = fetch(`${BASE}/ip/203.0.113.1`, init());
    const second = fetch(`${BASE}/ip/203.0.113.2`, init());
    await vi.advanceTimersByTimeAsync(0);
    api.calls[0]!.respond(429, { 'retry-after': '3' });
    expect((await first).status).toBe(429);
    await vi.advanceTimersByTimeAsync(2_900);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(2);
    api.calls[1]!.respond(429, { 'retry-after': '3600' });
    await second;

    // Retry-After above the cap waits the cap; no Retry-After waits the minimum.
    const third = fetch(`${BASE}/ip/203.0.113.3`, init());
    await vi.advanceTimersByTimeAsync(MAX_RATE_LIMIT_PAUSE_MS - 100);
    expect(api.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(3);
    api.calls[2]!.respond(429);
    await third;
    const fourth = fetch(`${BASE}/ip/203.0.113.4`, init());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS - 100);
    expect(api.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(4);
    api.calls[3]!.respond();
    expect((await fourth).status).toBe(200);
  });

  it('drops a queued request whose signal aborts, without sending it', async () => {
    vi.useFakeTimers();
    const clock = () => Date.now();
    const api = controlledFetch(clock);
    const fetch = budgetedHistoryFetch(api.fetch, { maxConcurrent: 1, perSecond: 1000 }, clock);
    const running = fetch(`${BASE}/ip/203.0.113.1`, init());
    const controller = new AbortController();
    const queued = fetch(`${BASE}/ip/203.0.113.2`, init(controller.signal));
    const rejection = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    api.calls[0]!.respond();
    await running;
    await vi.advanceTimersByTimeAsync(100);
    expect(api.calls).toHaveLength(1);

    const aborted = new AbortController();
    aborted.abort(new Error('cancelled before the call'));
    await expect(fetch(`${BASE}/ip/203.0.113.3`, init(aborted.signal))).rejects.toThrow(
      'cancelled before the call',
    );
    expect(api.calls).toHaveLength(1);
  });

  it('reads Retry-After as an HTTP date too', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-30T12:00:00Z'));
    const clock = () => Date.now();
    const api = controlledFetch(clock);
    const fetch = budgetedHistoryFetch(api.fetch, { maxConcurrent: 1, perSecond: 1000 }, clock);
    const first = fetch(`${BASE}/ip/203.0.113.1`, init());
    await vi.advanceTimersByTimeAsync(0);
    api.calls[0]!.respond(429, { 'retry-after': 'Wed, 30 Sep 2026 12:00:04 GMT' });
    await first;
    const second = fetch(`${BASE}/ip/203.0.113.2`, init());
    await vi.advanceTimersByTimeAsync(3_900);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.calls).toHaveLength(2);
    api.calls[1]!.respond(429, { 'retry-after': 'soon' });
    await second;
    // An unreadable Retry-After waits the minimum pause.
    const third = fetch(`${BASE}/ip/203.0.113.3`, init());
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_PAUSE_MS + 100);
    expect(api.calls).toHaveLength(3);
    api.calls[2]!.respond();
    await third;
  });

  it('uses the global fetch when no fetch is configured', async () => {
    const api = mockApiFetch();
    vi.stubGlobal('fetch', api.fetch);
    const ctx = createContext(buildServerConfig(FULL_ENV, { tools: undefined, offline: true }), {
      maxRetries: 0,
    });
    const page = await ctx.history!.history.search('ip', '203.0.113.200', { limit: 1 });
    expect(page.total).toBe(5);
    expect(api.calls).toHaveLength(1);
  });

  it('passes network errors through and frees the slot', async () => {
    const failing = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as FetchLike;
    const fetch = budgetedHistoryFetch(failing, { maxConcurrent: 1, perSecond: 1000 });
    await expect(fetch(`${BASE}/ip/203.0.113.1`, init())).rejects.toThrow('fetch failed');
    await expect(fetch(`${BASE}/ip/203.0.113.2`, init())).rejects.toThrow('fetch failed');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('is shared by every tool call of one server', async () => {
    const api = mockApiFetch();
    let inFlight = 0;
    let maxInFlight = 0;
    const counting: FetchLike = async (url, requestInit) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await api.fetch(url, requestInit);
      } finally {
        inFlight -= 1;
      }
    };
    connected = await connect(FULL_ENV, {
      apiFetch: counting,
      historyBudget: { maxConcurrent: 2, perSecond: 1000 },
    });
    const calls = ['203.0.113.200', '198.51.100.10', '198.51.100.11', '203.0.113.9'].map((ip) =>
      callTool(connected!.client, TOOL_NAMES.searchHistory, { type: 'ip', value: ip, limit: 1 }),
    );
    const results = await Promise.all(calls);
    for (const result of results) expect(result.isError, textOf(result)).toBeFalsy();
    expect(api.calls).toHaveLength(4);
    expect(maxInFlight).toBe(2);
  });
});
