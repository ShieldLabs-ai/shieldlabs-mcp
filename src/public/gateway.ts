import { base64Url, hmacSha256Base64Url } from './digest.js';

/**
 * Request header that proves a request to the MCP prefix of the ShieldLabs API comes from this
 * server. The API accepts an access token of the MCP audience only on that prefix and only with a
 * valid signature, so a token copied out of a client is useless anywhere else.
 */
export const GATEWAY_HEADER = 'X-Shield-Gateway';

/** The signing key this server shares with the ShieldLabs API (MCP_GATEWAY_KEY, "kid:secret"). */
export interface GatewayKey {
  /** ID under which the ShieldLabs API finds the secret, for example k1. */
  kid: string;
  secret: string;
}

export interface GatewayRequest {
  method: string;
  /** Path and query exactly as sent, for example /mcp/v1/ping. */
  requestUri: string;
  /** Lowercase hex SHA-256 of the bearer token the request carries. */
  tokenHash: string;
  /** Signing time in seconds since the epoch. The ShieldLabs API accepts 60 seconds either way. */
  unixSeconds: number;
  /** 16 to 64 base64url characters. The ShieldLabs API refuses a nonce it has seen before. */
  nonce: string;
}

/** Bytes of randomness in a nonce: 128 bits, 22 base64url characters. */
export const NONCE_BYTES = 16;

/** A fresh random nonce for one signed request. */
export function newNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** The request URI of an absolute URL as fetch sends it: the path and the query. */
export function requestUriOf(url: string): string {
  const { pathname, search } = new URL(url);
  return `${pathname}${search}`;
}

/**
 * The header value "v1 kid=<key ID> t=<time> n=<nonce> sig=<signature>". The signature is the
 * unpadded base64url HMAC-SHA256 of "v1", the time, the nonce, the method, the request URI and
 * the token hash, one per line.
 */
export async function gatewayHeader(key: GatewayKey, request: GatewayRequest): Promise<string> {
  const message = [
    'v1',
    String(request.unixSeconds),
    request.nonce,
    request.method,
    request.requestUri,
    request.tokenHash,
  ].join('\n');
  const signature = await hmacSha256Base64Url(key.secret, message);
  return `v1 kid=${key.kid} t=${request.unixSeconds} n=${request.nonce} sig=${signature}`;
}
