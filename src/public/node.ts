import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { MCP_HTTP_PATH } from '../constants.js';
import type { RunningHttpServer } from '../http.js';
import type { Logger } from '../log.js';
import type { PublicConfig } from './config.js';
import { handlePublicRequest, type PublicDependencies } from './handler.js';
import {
  ANONYMOUS_LIMIT,
  memoryRateLimiter,
  TOKEN_CHECK_LIMIT,
  TOKEN_LIMIT,
} from './rate-limit.js';
import { TokenCache } from './token.js';

export interface PublicHttpServerOptions {
  host: string;
  port: number;
  config: PublicConfig;
  /**
   * Take the client address of the per-address rate limits from CF-Connecting-IP, which the proxy
   * in front sets. Otherwise it is the address of the TCP connection, whatever the client sent.
   */
  trustProxy?: boolean;
  /** Startup and failure messages (stderr). */
  log: Logger;
  /** Receives one JSON line per request (stdout in the container). */
  requestLog: (line: string) => void;
  /** Overrides for tests. */
  deps?: Pick<PublicDependencies, 'fetch' | 'now' | 'nonce'>;
}

/**
 * The body of a Node.js request as a Web stream that reads only when pulled: the handler reads
 * it after authentication, and stops at the size limit without destroying the request.
 */
function bodyStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  const chunks = req.iterator({ destroyOnReturn: false });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const { done, value } = (await chunks.next()) as IteratorResult<Buffer, undefined>;
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      },
      async cancel() {
        await chunks.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

/** The address of the TCP peer, IPv4 without the ::ffff: prefix of a dual-stack socket. */
function peerAddress(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? 'unknown';
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address) ? address.slice(7) : address;
}

function toWebRequest(req: IncomingMessage, trustProxy: boolean, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, item);
    }
  }
  // The handler limits requests per CF-Connecting-IP. A client can send that header itself, so
  // it counts only when a trusted proxy sets it; otherwise it is the TCP peer.
  if (!trustProxy) headers.set('cf-connecting-ip', peerAddress(req));
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = bodyStream(req);
    init.duplex = 'half';
  }
  return new Request(new URL(req.url ?? '/', 'http://localhost'), init);
}

/**
 * Writes the response. When the handler left part of the body unread (a refused or oversized
 * request), the rest is drained and discarded: closing the connection instead would reset it
 * while the client is still sending, before it reads the answer.
 */
async function send(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
  const body = new Uint8Array(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(body);
  if (!req.complete) req.resume();
}

/**
 * Serves the public mode over plain HTTP from Node.js, for a container behind a TLS proxy (the
 * alternative to the Worker). The same handler runs; the rate limiters are in memory, and one
 * process shares the token cache and the JSON Schema validator.
 */
export async function startPublicHttpServer(
  options: PublicHttpServerOptions,
): Promise<RunningHttpServer> {
  const deps: PublicDependencies = {
    cache: new TokenCache(),
    rateLimiters: {
      token: memoryRateLimiter(TOKEN_LIMIT.limit, TOKEN_LIMIT.periodMs),
      anon: memoryRateLimiter(ANONYMOUS_LIMIT.limit, ANONYMOUS_LIMIT.periodMs),
      tokenCheck: memoryRateLimiter(TOKEN_CHECK_LIMIT.limit, TOKEN_CHECK_LIMIT.periodMs),
    },
    // Without it, every request would build its own Ajv instance.
    jsonSchemaValidator: new AjvJsonSchemaValidator(),
    log: options.requestLog,
    ...options.deps,
  };

  const server = createServer((req, res) => {
    const controller = new AbortController();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    handlePublicRequest(
      toWebRequest(req, options.trustProxy ?? false, controller.signal),
      options.config,
      deps,
    )
      .then((response) => send(req, res, response))
      .catch(() => {
        options.log('HTTP request failed.');
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error.' },
            id: null,
          }),
        );
      })
      .finally(() => {
        req.off('aborted', abort);
        res.off('close', abort);
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
