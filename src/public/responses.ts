import { SUPPORT_EMAIL } from '../constants.js';
import { LOOPBACK_HOSTS, type PublicConfig } from './config.js';
import { challenge } from './metadata.js';

/** Request headers a browser client may send to /mcp. */
export const CORS_ALLOW_HEADERS =
  'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, last-event-id';
/** Response headers a browser client may read: the challenge and the protocol version. */
export const CORS_EXPOSE_HEADERS = 'www-authenticate, mcp-protocol-version';

/** Headers of a CORS preflight answer for /mcp, besides the allowed origin. */
export const MCP_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
  'Access-Control-Max-Age': '600',
};

/**
 * Browser origins public mode accepts: any https origin, and http on localhost, 127.0.0.1 or
 * [::1] (local inspectors). Tokens travel in the Authorization header, never in cookies, so
 * reflecting such an origin gives a web page nothing it did not have.
 */
export function isAllowedOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  );
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A JSON-RPC error without a request ID, as the transport answers before reading a message. */
export function rpcErrorResponse(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

/** The response with extra headers (headers of a fetched or SDK response can be immutable). */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/** 401 without a token: the challenge that starts the sign-in. */
export function unauthorizedResponse(config: PublicConfig): Response {
  return jsonResponse(
    401,
    {
      error: 'unauthorized',
      error_description: 'Sign in to ShieldLabs from your MCP client to use this server.',
    },
    { 'WWW-Authenticate': challenge(config) },
  );
}

/**
 * 401 for a token the ShieldLabs API does not accept (unknown, expired or revoked), and for any
 * credential that is not a ShieldLabs access token, API keys included: they are not accepted here
 * yet.
 */
export function invalidTokenResponse(config: PublicConfig): Response {
  return jsonResponse(
    401,
    {
      error: 'invalid_token',
      error_description:
        'The access token is expired, revoked or not a ShieldLabs access token. Sign in to ShieldLabs from your MCP client again; API keys are not accepted by this server yet.',
    },
    { 'WWW-Authenticate': challenge(config, 'invalid_token') },
  );
}

export function tooManyRequestsResponse(retryAfterSeconds: number): Response {
  return jsonResponse(
    429,
    {
      error: 'rate_limited',
      error_description: `Too many requests. Retry in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    },
    { 'Retry-After': String(retryAfterSeconds) },
  );
}

/** 503 when the ShieldLabs API cannot check the token (down, slow or failing). */
export function unavailableResponse(): Response {
  return jsonResponse(
    503,
    {
      error: 'temporarily_unavailable',
      error_description: 'ShieldLabs could not check the access token. Retry in a few seconds.',
    },
    { 'Retry-After': '5' },
  );
}

/**
 * 500 for a problem of this server: unusable settings, or a ShieldLabs API that refuses its
 * signature or answers in an unexpected way. The log line says which.
 */
export function serverErrorResponse(): Response {
  return jsonResponse(500, {
    error: 'server_error',
    error_description: `The ShieldLabs MCP server could not handle the request because of a problem on the server side. Retry later; if it persists, contact ${SUPPORT_EMAIL}.`,
  });
}
