import { HEALTH_PATH, MCP_HTTP_PATH } from '../constants.js';
import { METADATA_PATHS } from './metadata.js';
import { PUBLIC_TOOL_NAMES } from './server.js';

/**
 * One log line per request. It never holds a token, a signature, a request or response body or
 * tool arguments: `token` is 8 hex characters of the SHA-256 of the access token.
 */
export interface RequestLog {
  ts: string;
  /** Cloudflare Ray ID, or a random ID. */
  rid: string;
  route: string;
  rpc?: string | undefined;
  tool?: string | undefined;
  status?: number;
  ms?: number;
  token?: string;
  /**
   * How the token was checked: cached, or the answer of the ShieldLabs API (ok, invalid_token,
   * gateway_<reason>, unavailable, unexpected_<status>), or throttled.
   */
  check?: string;
  /** Class of an unexpected error, with its message (never a secret). */
  error?: string;
  message?: string;
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** A client-supplied ID, kept only when it cannot carry text into the log. */
export function safeId(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && SAFE_ID.test(value) ? value : undefined;
}

/** The route of a path: one of the served paths, or "other" (paths are never logged verbatim). */
export function routeOf(pathname: string): string {
  return pathname === MCP_HTTP_PATH || pathname === HEALTH_PATH || METADATA_PATHS.includes(pathname)
    ? pathname
    : 'other';
}

/**
 * The JSON-RPC method of a request body, and the tool of a tools/call: only known tool names and
 * method-shaped values are kept; a batch is "batch".
 */
export function rpcSummary(body: unknown): Pick<RequestLog, 'rpc' | 'tool'> {
  if (Array.isArray(body)) return { rpc: 'batch' };
  if (typeof body !== 'object' || body === null) return {};
  const { method, params } = body as { method?: unknown; params?: unknown };
  if (typeof method !== 'string' || !/^[a-z][a-z/_]{0,63}$/i.test(method)) return {};
  if (method !== 'tools/call' || typeof params !== 'object' || params === null) {
    return { rpc: method };
  }
  const name = (params as { name?: unknown }).name;
  return { rpc: method, tool: PUBLIC_TOOL_NAMES.find((tool) => tool === name) };
}

/** The line as JSON, with its fields in a fixed order. */
export function formatRequestLog(entry: RequestLog): string {
  const { ts, rid, route, rpc, tool, status, ms, token, check, error, message } = entry;
  return JSON.stringify({ ts, rid, route, rpc, tool, status, ms, token, check, error, message });
}
