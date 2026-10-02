import type { FetchLike, FetchResponseLike } from '@shieldlabs-ai/node';

/** How many History API requests this process sends. Every tool call and client shares it. */
export interface HistoryBudget {
  /** Most requests in flight at once. */
  maxConcurrent: number;
  /** Most requests started per second. */
  perSecond: number;
}

/**
 * The History API allows about 15 requests per second per domain, shared with the site's own
 * backend (which polls it for new verdicts), so this server stays well below that.
 */
export const DEFAULT_HISTORY_BUDGET: Readonly<HistoryBudget> = { maxConcurrent: 2, perSecond: 5 };

/** After a 429, every queued History API request waits at least this long... */
export const RATE_LIMIT_PAUSE_MS = 1_000;
/** ...and at most this long, even when Retry-After asks for more. */
export const MAX_RATE_LIMIT_PAUSE_MS = 5_000;

/** Why a signal aborted, as an Error (the reason itself when it is one). */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted.', { cause: reason });
  error.name = 'AbortError';
  return error;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Milliseconds a Retry-After header asks for (seconds or an HTTP date), undefined when absent. */
function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Wraps the fetch of the History client in the process-wide budget: at most
 * `budget.maxConcurrent` requests in flight and `budget.perSecond` started per second, served in
 * order. A 429 pauses every queued request for a moment (Retry-After, from 1 to 5 seconds), so
 * parallel tool calls back off together instead of spending the domain's shared limit. A queued
 * request whose signal aborts (a cancelled tool call, an attempt timeout) leaves the queue
 * without being sent. URLs are sent exactly as the History client built them.
 *
 * `clock` must advance with setTimeout (monotonic milliseconds).
 */
export function budgetedFetch<
  I extends { signal: AbortSignal },
  R extends Pick<FetchResponseLike, 'status' | 'headers'>,
>(
  fetch: (url: string, init: I) => Promise<R>,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
  clock: () => number = () => performance.now(),
): (url: string, init: I) => Promise<R> {
  const spacing = 1000 / budget.perSecond;
  const queue: (() => void)[] = [];
  let inFlight = 0;
  let nextStartAt = -Infinity;
  let pausedUntil = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pump = (): void => {
    if (timer !== undefined) return;
    while (queue.length > 0 && inFlight < budget.maxConcurrent) {
      const now = clock();
      const readyAt = Math.max(nextStartAt, pausedUntil);
      if (now < readyAt) {
        timer = setTimeout(() => {
          timer = undefined;
          pump();
        }, readyAt - now);
        return;
      }
      nextStartAt = now + spacing;
      inFlight += 1;
      (queue.shift() as () => void)();
    }
  };

  const pauseAfterRateLimit = (response: Pick<FetchResponseLike, 'status' | 'headers'>): void => {
    const asked = retryAfterMs(response.headers.get('retry-after'), Date.now());
    const pause = Math.min(
      MAX_RATE_LIMIT_PAUSE_MS,
      Math.max(RATE_LIMIT_PAUSE_MS, asked ?? RATE_LIMIT_PAUSE_MS),
    );
    pausedUntil = Math.max(pausedUntil, clock() + pause);
  };

  return (url, init) =>
    new Promise<R>((resolve, reject) => {
      const { signal } = init;
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      const start = (): void => {
        signal.removeEventListener('abort', onAbort);
        Promise.resolve()
          .then(() => fetch(url, init))
          .then((response) => {
            try {
              if (response.status === 429) pauseAfterRateLimit(response);
            } finally {
              resolve(response);
            }
          })
          .catch((error: unknown) => reject(asError(error)))
          .finally(() => {
            inFlight -= 1;
            pump();
          });
      };
      const onAbort = (): void => {
        const index = queue.indexOf(start);
        if (index === -1) return;
        queue.splice(index, 1);
        if (queue.length === 0 && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(start);
      pump();
    });
}

/** Original History SDK adapter, preserving local API-key mode and its budget semantics. */
export function budgetedHistoryFetch(
  fetch: FetchLike,
  budget: HistoryBudget = DEFAULT_HISTORY_BUDGET,
  clock: () => number = () => performance.now(),
): FetchLike {
  return budgetedFetch(fetch, budget, clock);
}
