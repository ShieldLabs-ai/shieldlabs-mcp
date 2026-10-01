/** A request limiter per key. The Workers Rate Limiting binding has this shape. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Requests with an accepted token: per token (RL_TOKEN). */
export const TOKEN_LIMIT = { limit: 120, periodMs: 60_000 } as const;
/** Requests without an accepted token: per client IP address (RL_ANON). */
export const ANONYMOUS_LIMIT = { limit: 60, periodMs: 60_000 } as const;
/**
 * Pings of the ShieldLabs API for tokens that are not in the cache: per client IP address
 * (RL_TOKEN_CHECK). Every new token value starts with a full RL_TOKEN bucket, so this limit is
 * what bounds the pings one client can cause. It is higher than RL_ANON because accepted tokens
 * count too: many users can share the address of one network.
 */
export const TOKEN_CHECK_LIMIT = { limit: 300, periodMs: 60_000 } as const;

/** Keys an in-memory limiter tracks at most; the least recently used is dropped first. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Networks whose requests skip the per-IP limits: Claude's hosted connectors reach this server
 * from 160.79.104.0/21 on behalf of all of their users, who would otherwise share one budget.
 */
const SHARED_EGRESS_NETWORKS: readonly [string, number][] = [['160.79.104.0', 21]];

/** An IPv4 address as a 32-bit number, or undefined for anything else. */
function ipv4Number(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return undefined;
  }
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

/**
 * The per-IP key of a request, from CF-Connecting-IP (set by Cloudflare in front of the Worker,
 * and by the Node.js server or its trusted proxy in the container; requests without it share one
 * key). Undefined for the shared egress networks, which skip the per-IP limits.
 */
export function addressKey(request: Request): string | undefined {
  const address = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
  const value = ipv4Number(address);
  if (value !== undefined) {
    for (const [network, bits] of SHARED_EGRESS_NETWORKS) {
      const size = 2 ** (32 - bits);
      if (Math.floor(value / size) === Math.floor((ipv4Number(network) as number) / size)) {
        return undefined;
      }
    }
  }
  return `ip:${address}`;
}

/** True when the limiter lets the request through. No limiter, or a failing one, never blocks. */
export async function allowRequest(
  limiter: RateLimiter | undefined,
  key: string | undefined,
): Promise<boolean> {
  if (limiter === undefined || key === undefined) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
  }
}

/**
 * An in-memory token bucket per key, for the Node.js container: `limit` requests at once,
 * refilled at `limit` per `periodMs`.
 */
export function memoryRateLimiter(
  limit: number,
  periodMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, { tokens: number; updatedAt: number }>();
  return {
    limit({ key }) {
      const time = now();
      const bucket = buckets.get(key) ?? { tokens: limit, updatedAt: time };
      buckets.delete(key);
      bucket.tokens = Math.min(
        limit,
        bucket.tokens + ((time - bucket.updatedAt) * limit) / periodMs,
      );
      bucket.updatedAt = time;
      const success = bucket.tokens >= 1;
      if (success) bucket.tokens -= 1;
      buckets.set(key, bucket);
      for (const oldest of buckets.keys()) {
        if (buckets.size <= MAX_TRACKED_KEYS) break;
        buckets.delete(oldest);
      }
      return Promise.resolve({ success });
    },
  };
}
