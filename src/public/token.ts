/**
 * How long the ShieldLabs API's answer that a token works is reused in one Worker isolate or
 * Node.js process. Refusals are never remembered.
 */
export const TOKEN_CACHE_TTL_MS = 60_000;

/** Tokens remembered at most; the least recently used goes first. */
export const MAX_CACHED_TOKENS = 1_000;

/**
 * The shape of an access token of the MCP audience: "slat_" and 43 base64url characters. Any
 * other credential (an API key, a refresh token, a dashboard session) is refused without being
 * sent anywhere.
 */
const ACCESS_TOKEN = /^slat_[A-Za-z0-9_-]{43}$/;

const BEARER = /^Bearer\s+(.+)$/i;

/** The credential of an Authorization: Bearer header, or undefined for none or another scheme. */
export function bearerToken(header: string | null): string | undefined {
  const match = header?.trim().match(BEARER);
  return match === null || match === undefined ? undefined : (match[1] as string).trim();
}

export function isAccessToken(value: string): boolean {
  return ACCESS_TOKEN.test(value);
}

/**
 * Tokens the ShieldLabs API accepted recently, keyed by the SHA-256 of the token (never the
 * token itself), each until its own deadline.
 */
export class TokenCache {
  readonly #expiries = new Map<string, number>();

  constructor(
    readonly ttlMs = TOKEN_CACHE_TTL_MS,
    readonly maxEntries = MAX_CACHED_TOKENS,
  ) {}

  get size(): number {
    return this.#expiries.size;
  }

  /** True while the token is remembered as accepted. */
  has(hash: string, now: number): boolean {
    const expiresAt = this.#expiries.get(hash);
    if (expiresAt === undefined) return false;
    this.#expiries.delete(hash);
    if (expiresAt <= now) return false;
    this.#expiries.set(hash, expiresAt);
    return true;
  }

  /** Remembers that the ShieldLabs API accepted the token at `now`. */
  remember(hash: string, now: number): void {
    this.#expiries.delete(hash);
    this.#expiries.set(hash, now + this.ttlMs);
    for (const oldest of this.#expiries.keys()) {
      if (this.#expiries.size <= this.maxEntries) break;
      this.#expiries.delete(oldest);
    }
  }

  forget(hash: string): void {
    this.#expiries.delete(hash);
  }
}
