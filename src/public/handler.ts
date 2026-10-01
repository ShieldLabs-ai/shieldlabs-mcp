import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { HEALTH_PATH, MAX_HTTP_BODY_BYTES, MCP_HTTP_PATH, SERVER_VERSION } from '../constants.js';
import type { PublicConfig } from './config.js';
import { sha256Hex } from './digest.js';
import { METADATA_PATHS, protectedResourceMetadata } from './metadata.js';
import {
  checkToken,
  PING_PATH,
  pingPortal,
  type PingDependencies,
  type PingResult,
  type PortalFetch,
  type TokenCheck,
} from './portal.js';
import {
  addressKey,
  allowRequest,
  ANONYMOUS_LIMIT,
  TOKEN_CHECK_LIMIT,
  TOKEN_LIMIT,
  type RateLimiter,
} from './rate-limit.js';
import { formatRequestLog, routeOf, rpcSummary, safeId, type RequestLog } from './request-log.js';
import {
  CORS_EXPOSE_HEADERS,
  invalidTokenResponse,
  isAllowedOrigin,
  jsonResponse,
  MCP_PREFLIGHT_HEADERS,
  rpcErrorResponse,
  serverErrorResponse,
  tooManyRequestsResponse,
  unauthorizedResponse,
  unavailableResponse,
  withHeaders,
} from './responses.js';
import { createPublicServer } from './server.js';
import { bearerToken, isAccessToken, type TokenCache } from './token.js';

export interface PublicDependencies {
  /** Tokens the ShieldLabs API accepted recently. One cache per Worker isolate or Node.js process. */
  cache: TokenCache;
  /** RL_TOKEN, RL_ANON and RL_TOKEN_CHECK. A missing limiter lets every request through. */
  rateLimiters?: {
    token?: RateLimiter | undefined;
    anon?: RateLimiter | undefined;
    tokenCheck?: RateLimiter | undefined;
  };
  /** JSON Schema validator of each MCP server: CfWorkerJsonSchemaValidator on Workers. */
  jsonSchemaValidator?: jsonSchemaValidator;
  /** Keeps work alive after the response (Workers: ExecutionContext.waitUntil). */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Receives one JSON line per request. */
  log?: (line: string) => void;
  /** fetch for the ShieldLabs API. Default: the global fetch. */
  fetch?: PortalFetch;
  /** Clock in epoch milliseconds. */
  now?: () => number;
  /** Nonce generator of the gateway signature, for tests. */
  nonce?: () => string;
}

/** The global fetch, looked up at call time (a test can replace it). */
const globalFetch: PortalFetch = (url, init) => globalThis.fetch(url, init);

/** Replaces each secret in `text`, and anything shaped like a ShieldLabs token, by [redacted]. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  // A base64url token can end in "-", where \b does not match: bound the token by characters.
  return result.replace(/(?<![A-Za-z0-9])(slat|slrt)_[A-Za-z0-9_-]{43,}/g, '$1_[redacted]');
}

/** The log label of a token check. */
function checkLabel(check: TokenCheck): string {
  switch (check.outcome) {
    case 'ok':
      return check.cached ? 'cached' : 'ok';
    case 'gateway_rejected':
      return check.reason;
    case 'unexpected':
      return `unexpected_${check.status}`;
    default:
      return check.outcome;
  }
}

/**
 * Records an answer of the ShieldLabs API that points to a problem of this server: a refused
 * signature, or an answer the MCP prefix never gives. Nothing secret goes into the message.
 */
function recordServerProblem(entry: RequestLog, result: PingResult): void {
  if (result.outcome === 'gateway_rejected') {
    entry.error = 'GatewaySignatureRejected';
    entry.message = `The ShieldLabs API refused the X-Shield-Gateway signature (${result.reason}). Check that MCP_GATEWAY_KEY matches an entry of MCP_GATEWAY_KEYS of the API, and the clock of this server.`;
  } else if (result.outcome === 'unexpected') {
    entry.error = 'UnexpectedApiAnswer';
    entry.message = `GET ${PING_PATH} answered HTTP ${result.status}. Check SHIELDLABS_PORTAL_URL and that the MCP prefix is enabled in the ShieldLabs API.`;
  }
}

/** The body as text, or undefined when it has more than `limit` bytes (reading stops there). */
async function readBodyText(request: Request, limit: number): Promise<string | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return undefined;
  const stream: ReadableStream<Uint8Array> | null = request.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A 401 for a missing or refused token, or 429 when this address sends too many of them. */
async function refuse(
  request: Request,
  deps: PublicDependencies,
  response: Response,
): Promise<Response> {
  const allowed = await allowRequest(deps.rateLimiters?.anon, addressKey(request));
  return allowed ? response : tooManyRequestsResponse(ANONYMOUS_LIMIT.periodMs / 1000);
}

/** Authenticates a request to /mcp and serves it with a server built for its token. */
async function serveMcp(
  request: Request,
  config: PublicConfig,
  deps: PublicDependencies,
  entry: RequestLog,
  secrets: string[],
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const token = bearerToken(request.headers.get('authorization'));
  if (token === undefined) return refuse(request, deps, unauthorizedResponse(config));
  // API keys and every other credential get the same answer as an expired token, unsent.
  if (!isAccessToken(token)) return refuse(request, deps, invalidTokenResponse(config));
  secrets.push(token);
  const tokenHash = await sha256Hex(token);
  entry.token = tokenHash.slice(0, 8);
  if (!(await allowRequest(deps.rateLimiters?.token, `t:${tokenHash}`))) {
    return tooManyRequestsResponse(TOKEN_LIMIT.periodMs / 1000);
  }

  const ping: PingDependencies = {
    config,
    fetch: deps.fetch ?? globalFetch,
    now,
    ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
  };
  // A token that is not in the cache costs a ping before anything says whether it is valid:
  // limit those pings per client address.
  const check = await checkToken(token, tokenHash, deps.cache, ping, () =>
    allowRequest(deps.rateLimiters?.tokenCheck, addressKey(request)),
  );
  entry.check = checkLabel(check);
  switch (check.outcome) {
    case 'invalid_token':
      return refuse(request, deps, invalidTokenResponse(config));
    case 'throttled':
      return tooManyRequestsResponse(TOKEN_CHECK_LIMIT.periodMs / 1000);
    case 'unavailable':
      return unavailableResponse();
    case 'gateway_rejected':
    case 'unexpected':
      recordServerProblem(entry, check);
      return serverErrorResponse();
  }

  if (request.method !== 'POST') {
    return rpcErrorResponse(405, -32000, 'Method not allowed: this server accepts POST only.', {
      Allow: 'POST, OPTIONS',
    });
  }
  const text = await readBodyText(request, MAX_HTTP_BODY_BYTES);
  if (text === undefined) {
    return rpcErrorResponse(413, -32000, `Request body larger than ${MAX_HTTP_BODY_BYTES} bytes.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcErrorResponse(400, -32700, 'Parse error: the body is not valid JSON.');
  }
  Object.assign(entry, rpcSummary(body));
  // One message per request, as streamable HTTP requires since protocol revision 2025-06-18: a
  // batch would run many tool calls on one request of the per-token rate limit.
  if (Array.isArray(body)) {
    return rpcErrorResponse(
      400,
      -32600,
      'Invalid Request: batches are not supported. Send one JSON-RPC message per request.',
    );
  }

  const server = createPublicServer({
    now,
    ...(deps.jsonSchemaValidator === undefined
      ? {}
      : { jsonSchemaValidator: deps.jsonSchemaValidator }),
    // The tool asks the ShieldLabs API again instead of trusting the cache: that is its purpose.
    checkConnection: async () => {
      const result = await pingPortal(token, tokenHash, ping);
      if (result.outcome === 'ok') deps.cache.remember(tokenHash, now());
      else if (result.outcome === 'invalid_token') deps.cache.forget(tokenHash);
      recordServerProblem(entry, result);
      return result;
    },
  });
  // No session ID generator: stateless mode, one transport per request, JSON responses.
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, { parsedBody: body });
  } finally {
    // The JSON response is complete: release the server of this request.
    const closed = Promise.allSettled([transport.close(), server.close()]);
    deps.waitUntil?.(closed);
  }
}

function metadataResponse(method: string, config: PublicConfig): Response {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'mcp-protocol-version',
        'Access-Control-Max-Age': '600',
      },
    });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonResponse(
      405,
      { error: 'method not allowed' },
      { ...cors, Allow: 'GET, HEAD, OPTIONS' },
    );
  }
  return jsonResponse(200, protectedResourceMetadata(config), {
    ...cors,
    'Cache-Control': 'public, max-age=300',
  });
}

async function route(
  request: Request,
  pathname: string,
  config: PublicConfig,
  deps: PublicDependencies,
  entry: RequestLog,
  secrets: string[],
): Promise<Response> {
  if (METADATA_PATHS.includes(pathname)) return metadataResponse(request.method, config);
  if (pathname === HEALTH_PATH) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    }
    return jsonResponse(200, { status: 'ok', version: SERVER_VERSION });
  }
  if (pathname !== MCP_HTTP_PATH) return jsonResponse(404, { error: 'not found' });

  const origin = request.headers.get('origin');
  if (origin !== null && !isAllowedOrigin(origin)) {
    return rpcErrorResponse(
      403,
      -32000,
      'Forbidden: origin not allowed. Browser clients must be served over https, or over http from localhost.',
    );
  }
  const cors: Record<string, string> =
    origin === null ? {} : { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, ...MCP_PREFLIGHT_HEADERS } });
  }
  const response = await serveMcp(request, config, deps, entry, secrets);
  return origin === null
    ? response
    : withHeaders(response, { ...cors, 'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS });
}

/**
 * Serves one request of the public (hosted, multi-tenant) mode. Web-standard: the Worker entry
 * and the Node.js container both call it.
 *
 * Routes: /health; the protected resource metadata; and /mcp, which authenticates every request
 * before any JSON-RPC runs. A request without a token gets the 401 challenge that starts the
 * sign-in. Access tokens are checked with GET /mcp/v1/ping of the ShieldLabs API, signed with
 * the gateway key, and an accepted token is remembered by its hash for up to 60 seconds.
 */
export async function handlePublicRequest(
  request: Request,
  config: PublicConfig,
  deps: PublicDependencies,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const { pathname } = new URL(request.url);
  const entry: RequestLog = {
    ts: new Date(started).toISOString(),
    rid: safeId(request.headers.get('cf-ray')) ?? crypto.randomUUID(),
    route: routeOf(pathname),
  };
  const secrets = [config.gatewayKey.secret];
  let response: Response;
  try {
    response = await route(request, pathname, config, deps, entry, secrets);
  } catch (error) {
    entry.error = error instanceof Error ? error.name : typeof error;
    entry.message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    response = rpcErrorResponse(500, -32603, 'Internal server error.');
  }
  entry.status = response.status;
  entry.ms = now() - started;
  deps.log?.(formatRequestLog(entry));
  return response;
}
