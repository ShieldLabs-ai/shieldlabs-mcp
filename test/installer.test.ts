import { installerSuite } from './installer-cases.js';
import { expect, it, vi } from 'vitest';
import { harness, installerRequest } from './installer-cases.js';

installerSuite();

it('total 90s deadline aborts stalled SDK transport after one authorization, without retry', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    h.provider.mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = h.run();
    await vi.waitFor(() => expect(h.provider).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await pending).status).toBe(503);
    expect(h.provider.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(h.portal).toHaveBeenCalledTimes(1);
    expect(h.provider).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('3s Portal deadline fails closed with no paid call', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    h.portal.mockImplementation(() => new Promise<Response>(() => undefined));
    const pending = h.run();
    await vi.waitFor(() => expect(h.portal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).status).toBe(503);
    expect(h.provider).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('10s slow body deadline cancels reader before Portal/token authorization', async () => {
  vi.useFakeTimers();
  try {
    const h = harness();
    const cancel = vi.fn();
    const base = installerRequest();
    const request = new Request(base.url, {
      method: 'POST',
      headers: base.headers,
      body: new ReadableStream({ cancel }),
      duplex: 'half',
    });
    const pending = h.run(request);
    await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).status).toBe(503);
    expect(cancel).toHaveBeenCalled();
    expect(h.portal).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
