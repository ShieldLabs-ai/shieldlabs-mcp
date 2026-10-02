import type { FetchResponseLike } from '@shieldlabs-ai/node';
import { SERVER_VERSION } from '../constants.js';
import { budgetedFetch } from '../history-fetch.js';
import type { PublicConfig } from './config.js';
import { GATEWAY_HEADER, gatewayHeader, newNonce, requestUriOf } from './gateway.js';
import type { PortalFetch, PortalResponse } from './portal.js';

export const OPERATION_TIMEOUT_MS = 10_000;
export const MAX_BACKEND_BYTES = 1024 * 1024;
export type OperationMethod = Parameters<PortalFetch>[1]['method'];
export type JsonObject = Record<string, unknown>;

/** Only controlled messages are returned; upstream bodies and exception messages are never used. */
export class OperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OperationError('invalid_response', 'ShieldLabs returned an invalid response.');
  }
  return value as JsonObject;
}

async function boundedText(response: PortalResponse, signal: AbortSignal): Promise<string> {
  if (Number(response.headers?.get('content-length') ?? 0) > MAX_BACKEND_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new OperationError('response_too_large', 'Response exceeds 1 MiB. Use a smaller limit.');
  }
  if (response.body === undefined || response.body === null) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_BACKEND_BYTES) {
      throw new OperationError(
        'response_too_large',
        'Response exceeds 1 MiB. Use a smaller limit.',
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_BACKEND_BYTES) {
        throw new OperationError(
          'response_too_large',
          'Response exceeds 1 MiB. Use a smaller limit.',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Abort even a custom fetch/body reader that ignores its signal. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new OperationError('cancelled', 'Operation cancelled or timed out.'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

type ScheduledFetch = (url: string, init: Parameters<PortalFetch>[1]) => Promise<FetchResponseLike>;

/** Request-local scheduler: workerd timers must not outlive the request that owns them. */
function scheduled(fetch: PortalFetch): ScheduledFetch {
  return budgetedFetch(async (url, init: Parameters<PortalFetch>[1]) => {
    // The scheduler releases its slot only after the bounded response has been read.
    const response = await abortable(
      fetch(url, {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        redirect: 'manual',
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
      init.signal,
    );
    const text = await abortable(boundedText(response, init.signal), init.signal);
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers ?? { get: () => null },
      text: () => Promise.resolve(text),
    };
  });
}

export interface OperationsOptions {
  config: PublicConfig;
  fetch: PortalFetch;
  token: string;
  tokenHash: string;
  now: () => number;
  nonce?: () => string;
  signal?: AbortSignal;
  onInvalidToken?: () => void;
}

/** Request-local credentials and cancellation. Only the MCP contour can be addressed. */
export class OperationsClient {
  private calls = 0;
  private readonly fetch: ScheduledFetch;
  constructor(private readonly options: OperationsOptions) {
    this.fetch = scheduled(options.fetch);
  }

  async request(
    method: OperationMethod,
    path: string,
    body?: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    if (!path.startsWith('/mcp/v1/') || /[\r\n#]/.test(path)) {
      throw new OperationError('invalid_path', 'Only MCP operations are supported.');
    }
    if (++this.calls > 12)
      throw new OperationError(
        'budget_exceeded',
        'Request budget exceeded. Use a smaller history window.',
      );
    const raw = body === undefined ? '' : JSON.stringify(body);
    if (new TextEncoder().encode(raw).length > MAX_BACKEND_BYTES) {
      throw new OperationError('request_too_large', 'Request exceeds 1 MiB.');
    }
    const controller = new AbortController();
    const parents = [signal, this.options.signal].filter((s): s is AbortSignal => s !== undefined);
    const abort = () => controller.abort();
    for (const parent of parents) {
      parent.addEventListener('abort', abort, { once: true });
      if (parent.aborted) abort();
    }
    const timer = setTimeout(abort, OPERATION_TIMEOUT_MS);
    try {
      if (controller.signal.aborted) throw new OperationError('cancelled', 'Operation cancelled.');
      const { config, token, tokenHash, now, nonce = newNonce } = this.options;
      const url = `${config.portalUrl}${path}`;
      if (!new URL(url).pathname.startsWith('/mcp/v1/')) {
        throw new OperationError('invalid_path', 'Only MCP operations are supported.');
      }
      const signature = await gatewayHeader(config.gatewayKey, {
        method,
        requestUri: requestUriOf(url),
        tokenHash,
        unixSeconds: Math.floor(now() / 1000),
        nonce: nonce(),
        ...(method === 'GET' ? {} : { body: raw }),
      });
      // No automatic retries: a mutation can have succeeded before a connection was lost.
      const response = await this.fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': `shieldlabs-mcp/${SERVER_VERSION}`,
          [GATEWAY_HEADER]: signature,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        signal: controller.signal,
        redirect: 'manual',
        ...(body === undefined ? {} : { body: raw }),
      });
      const text = await response.text();
      let parsed: JsonObject = {};
      if (text !== '') {
        try {
          parsed = object(JSON.parse(text));
        } catch {
          if (response.ok)
            throw new OperationError(
              'invalid_response',
              'ShieldLabs returned invalid JSON. Check connection and retry reads; verify state before retrying mutations.',
            );
        }
      }
      if (response.ok) return response.status === 204 ? { deleted: true } : parsed;
      if (response.status === 401) {
        if (parsed.error === 'invalid_token') {
          this.options.onInvalidToken?.();
          throw new OperationError(
            'invalid_token',
            'Reconnect ShieldLabs in your MCP client to sign in again.',
          );
        }
        throw new OperationError(
          'gateway_rejected',
          'The hosted gateway signature was rejected. Contact ShieldLabs support.',
        );
      }
      if (parsed.code === 'domain_required' || parsed.code === 'unknown_domain') {
        const domains = Array.isArray(parsed.domains)
          ? parsed.domains
              .filter(
                (v): v is string =>
                  typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$/.test(v),
              )
              .slice(0, 50)
          : [];
        throw new OperationError(
          String(parsed.code),
          `Pass an enabled domain hostname from shieldlabs_list_domains. Available domains: ${JSON.stringify(domains)}.`,
        );
      }
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = Number(header);
        const asked =
          header !== null && Number.isFinite(seconds)
            ? seconds * 1000
            : Math.max(0, Date.parse(header ?? '') - Date.now());
        const advertised = Number.isFinite(asked) && asked >= 0 ? Math.ceil(asked) : 1_000;
        const pause = Math.min(10_000, advertised);
        throw new OperationError(
          'rate_limited',
          `Rate limit reached. ShieldLabs recommends waiting ${Math.ceil(advertised / 1000)} seconds before retrying.`,
          pause,
        );
      }
      const messages: Record<number, [string, string]> = {
        400: ['invalid_request', 'Invalid input. Check the tool fields and domain.'],
        402: [
          'quota_exceeded',
          'Account identification quota exhausted. Check the plan in ShieldLabs.',
        ],
        403: ['forbidden', 'This connection cannot access the operation. Reconnect ShieldLabs.'],
        404: [
          'not_found',
          'Domain, webhook or identification not found in this account. Check its ID.',
        ],
        409: [
          'conflict',
          'Operation conflicts with existing data or plan limits. Read the current state before retrying.',
        ],
        413: ['request_too_large', 'Request exceeds the backend body limit.'],
      };
      const [code, message] = messages[response.status] ?? [
        'unavailable',
        'ShieldLabs is temporarily unavailable. Retry reads later; verify current state before retrying mutations.',
      ];
      throw new OperationError(code, message);
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw new OperationError(
        'unavailable',
        'ShieldLabs did not complete the operation. Retry reads later; verify state before retrying mutations.',
      );
    } finally {
      clearTimeout(timer);
      for (const parent of parents) parent.removeEventListener('abort', abort);
    }
  }
}
