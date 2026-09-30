import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { HEALTH_PATH, MAX_HTTP_BODY_BYTES, MCP_HTTP_PATH } from './constants.js';
import type { Logger } from './log.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Bearer token every MCP request must present. */
  token: string;
  /** Browser origins allowed to call the endpoint. Requests with any other Origin header are refused. */
  allowedOrigins: readonly string[];
  /** Creates a fresh MCP server for one request (stateless mode). */
  createMcpServer: () => McpServer;
  log: Logger;
}

export interface RunningHttpServer {
  server: Server;
  /** URL of the MCP endpoint, for example http://127.0.0.1:8787/mcp. */
  url: string;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CORS_ALLOW_HEADERS =
  'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id';
const BEARER = /^Bearer\s+(.+)$/i;

/** A random bearer token for one run of the server. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Compares the Authorization header with the expected token in constant time. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const match = header.trim().match(BEARER);
  if (match === null) return false;
  return timingSafeEqual(digest((match[1] as string).trim()), digest(token));
}

/** Hostname of a Host header value, without the port ("[::1]:8787" gives "[::1]"). */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']');
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  const colon = hostHeader.lastIndexOf(':');
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
}

function sendRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

/**
 * Serves MCP over streamable HTTP in stateless mode: every POST to /mcp gets a fresh server and
 * transport with JSON responses. Requires a bearer token, refuses unknown browser origins, checks
 * the Host header on loopback binds (DNS rebinding protection) and exposes /health without data.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const { token, log } = options;
  const allowedOrigins = new Set(options.allowedOrigins);
  const checkHost = isLoopbackHost(options.host);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (path === HEALTH_PATH) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path !== MCP_HTTP_PATH) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const hostHeader = req.headers.host;
    if (checkHost && hostHeader !== undefined && !isLoopbackHost(hostnameOf(hostHeader))) {
      sendRpcError(
        res,
        403,
        -32000,
        'Forbidden: this server only accepts requests addressed to localhost.',
      );
      return;
    }

    const origin = req.headers.origin;
    const corsHeaders: Record<string, string> = {};
    if (origin !== undefined) {
      if (!allowedOrigins.has(origin)) {
        sendRpcError(
          res,
          403,
          -32000,
          'Forbidden: origin not allowed. Start the server with --allowed-origins to allow it.',
        );
        return;
      }
      corsHeaders['Access-Control-Allow-Origin'] = origin;
      corsHeaders.Vary = 'Origin';
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }

    if (!isAuthorized(req.headers.authorization, token)) {
      sendRpcError(
        res,
        401,
        -32001,
        'Unauthorized: send Authorization: Bearer <SHIELDLABS_MCP_TOKEN>.',
        {
          ...corsHeaders,
          'WWW-Authenticate': 'Bearer realm="shieldlabs-mcp"',
        },
      );
      return;
    }

    if (req.method !== 'POST') {
      sendRpcError(
        res,
        405,
        -32000,
        'Method not allowed: this stateless server accepts POST only.',
        {
          ...corsHeaders,
          Allow: 'POST, OPTIONS',
        },
      );
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MAX_HTTP_BODY_BYTES)) as unknown;
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendRpcError(res, 413, -32000, `Request body larger than ${MAX_HTTP_BODY_BYTES} bytes.`, {
          ...corsHeaders,
          Connection: 'close',
        });
        req.resume();
      } else {
        sendRpcError(res, 400, -32700, 'Parse error: the body is not valid JSON.', corsHeaders);
      }
      return;
    }

    for (const [name, value] of Object.entries(corsHeaders)) res.setHeader(name, value);
    const mcp = options.createMcpServer();
    // No session ID generator: stateless mode, one transport per request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK declares onclose as "T | undefined" on this class and as optional on Transport;
    // the two only differ under exactOptionalPropertyTypes.
    await mcp.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log(`HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal server error.');
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${displayHost}:${address.port}${MCP_HTTP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
