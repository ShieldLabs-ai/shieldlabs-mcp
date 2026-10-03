import Anthropic from '@anthropic-ai/sdk';
import type { PublicConfig } from '../public/config.js';
import { sha256Hex } from '../public/digest.js';
import { GATEWAY_HEADER, gatewayHeader, newNonce } from '../public/gateway.js';
import type { RateLimiter } from '../public/rate-limit.js';
import {
  CORS_EXPOSE_HEADERS,
  invalidTokenResponse,
  isAllowedOrigin,
  jsonResponse,
  MCP_PREFLIGHT_HEADERS,
  unauthorizedResponse,
  withHeaders,
} from '../public/responses.js';
import { bearerToken, isAccessToken } from '../public/token.js';
import {
  AUTHORIZE_PATH,
  AUTHORIZE_TIMEOUT_MS,
  BODY_TIMEOUT_MS,
  INSTALLER_MODEL,
  InstallerError,
  MAX_AUTH_BYTES,
  MAX_BODY_BYTES,
  MAX_OUTPUT_TOKENS,
  MAX_PROVIDER_BYTES,
  PROVIDER_URL,
  REQUEST_TIMEOUT_MS,
} from './limits.js';
import {
  INSTALLER_SYSTEM,
  parseClient,
  parseProposal,
  verificationFor,
  type ClientJSON,
  type AgentResult,
} from './schema.js';
import { abortable, readBounded } from './streams.js';
import { openbrokerPlan, OPENBROKER_MODELS } from './openbroker.js';

export interface InstallerEnv {
  INSTALLER_ENABLED?: string;
  INSTALLER_ANTHROPIC_API_KEY?: string;
  INSTALLER_PROVIDER?: string;
  INSTALLER_OPENBROKER_API_KEY?: string;
  INSTALLER_OPENBROKER_MODEL?: string;
  RL_INSTALLER_IP?: RateLimiter;
}

/** Separate fetch seams for offline tests, not client configuration or provider shims. */
export interface InstallerDependencies {
  portalFetch?: typeof globalThis.fetch;
  providerFetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}

async function authorize(
  token: string,
  config: PublicConfig,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<void> {
  const requestId = crypto.randomUUID();
  const body = JSON.stringify({ request_id: requestId });
  const signature = await gatewayHeader(config.gatewayKey, {
    method: 'POST',
    requestUri: AUTHORIZE_PATH,
    tokenHash: await sha256Hex(token),
    unixSeconds: Math.floor(Date.now() / 1000),
    nonce: newNonce(),
    body,
  });
  const response = await abortable(
    fetcher(`${config.portalUrl}${AUTHORIZE_PATH}`, {
      method: 'POST',
      body,
      signal,
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        [GATEWAY_HEADER]: signature,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    }),
    signal,
  );
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    const status = [401, 429, 503, 409].includes(response.status) ? response.status : 503;
    throw new InstallerError(
      status,
      status === 401 ? 'invalid_token' : 'installer_authorization_refused',
    );
  }
  const value: unknown = JSON.parse(await readBounded(response, MAX_AUTH_BYTES, signal, 503));
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).authorized !== true ||
    (value as Record<string, unknown>).request_id !== requestId
  ) {
    throw new InstallerError(503, 'installer_authorization_refused');
  }
}

/** SDK transport fenced to one URL, server headers and bounded response bytes. No redirect/retry. */
export function providerTransport(
  apiKey: string,
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): typeof globalThis.fetch {
  let attempted = false;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (attempted || url !== PROVIDER_URL || init?.method !== 'POST' || signal.aborted) {
      throw new InstallerError(503, 'installer_unavailable');
    }
    attempted = true;
    const response = await abortable(
      fetcher(PROVIDER_URL, {
        method: 'POST',
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': apiKey,
        },
      }),
      signal,
    );
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new InstallerError(502, 'installer_provider_failed');
    }
    const body = await readBounded(response, MAX_PROVIDER_BYTES, signal, 502);
    // Only fixed response headers are visible to the SDK; provider request IDs/content never log.
    return new Response(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

async function plan(
  request: ClientJSON,
  apiKey: string,
  secrets: string[],
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<AgentResult> {
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    timeout: REQUEST_TIMEOUT_MS,
    logLevel: 'off',
    fetch: providerTransport(apiKey, signal, fetcher),
  });
  const message = await abortable(
    client.messages.create(
      {
        model: INSTALLER_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: INSTALLER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              ...request,
              verificationAllowlist: verificationFor(request),
            }),
          },
        ],
      },
      { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
    ),
    signal,
  );
  if (
    message.stop_reason !== 'end_turn' ||
    message.model !== INSTALLER_MODEL ||
    !Array.isArray(message.content) ||
    message.content.length === 0 ||
    message.content.some((block) => !['text', 'thinking', 'redacted_thinking'].includes(block.type))
  ) {
    throw new InstallerError(502, 'invalid_installer_proposal');
  }
  const encoded = message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('');
  return parseProposal(encoded, request, secrets);
}

async function serve(
  request: Request,
  config: PublicConfig,
  env: InstallerEnv,
  deps: InstallerDependencies,
): Promise<Response> {
  // Cloudflare supplies the address. Unlike MCP ping limits, shared egress has NO exemption.
  if (!env.RL_INSTALLER_IP) throw new InstallerError(503, 'installer_unavailable');
  const key = `installer:ip:${request.headers.get('cf-connecting-ip')?.trim() || 'unknown'}`;
  const limited = await env.RL_INSTALLER_IP.limit({ key });
  if (!limited.success)
    return jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
  if (new URL(request.url).origin !== config.publicOrigin)
    return jsonResponse(404, { error: 'not_found' });
  const origin = request.headers.get('origin');
  if (origin !== null && !isAllowedOrigin(origin))
    return jsonResponse(403, { error: 'invalid_origin' });
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: MCP_PREFLIGHT_HEADERS });
  if (request.method !== 'POST')
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
  const provider = env.INSTALLER_PROVIDER ?? 'anthropic';
  const apiKey =
    provider === 'openbroker' ? env.INSTALLER_OPENBROKER_API_KEY : env.INSTALLER_ANTHROPIC_API_KEY;
  const model = env.INSTALLER_OPENBROKER_MODEL ?? '';
  if (
    env.INSTALLER_ENABLED !== 'true' ||
    !apiKey ||
    (provider === 'anthropic'
      ? !/^sk-ant-[A-Za-z0-9_-]{12,}$/.test(apiKey)
      : provider !== 'openbroker' ||
        !/^obk-[A-Za-z0-9_-]{12,}$/.test(apiKey) ||
        !OPENBROKER_MODELS.some((value) => value === model))
  ) {
    throw new InstallerError(503, 'installer_unavailable');
  }
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return unauthorizedResponse(config);
  if (!isAccessToken(token)) return invalidTokenResponse(config);
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    return jsonResponse(415, { error: 'unsupported_media_type' });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const deadline = setTimeout(abort, REQUEST_TIMEOUT_MS);
  const bodyDeadline = setTimeout(abort, BODY_TIMEOUT_MS);
  try {
    let encoded: string;
    try {
      encoded = await readBounded(request, MAX_BODY_BYTES, controller.signal);
    } finally {
      clearTimeout(bodyDeadline);
    }
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw new InstallerError(400, 'invalid_installer_request');
    }
    const secrets = [
      token,
      apiKey,
      config.gatewayKey.secret,
      env.INSTALLER_ANTHROPIC_API_KEY ?? '',
      env.INSTALLER_OPENBROKER_API_KEY ?? '',
    ];
    const input = parseClient(value, secrets);
    const authTimer = setTimeout(abort, AUTHORIZE_TIMEOUT_MS);
    try {
      // This is the shared stable-user + global budget reservation. Never use TokenCache/ping.
      await authorize(token, config, controller.signal, deps.portalFetch ?? globalThis.fetch);
    } finally {
      clearTimeout(authTimer);
    }
    if (controller.signal.aborted) throw new InstallerError(503, 'installer_unavailable');
    // A failed call still consumes Portal's reservation; there is no refund or automatic retry.
    return jsonResponse(
      200,
      await (provider === 'openbroker'
        ? openbrokerPlan(
            input,
            apiKey,
            model,
            secrets,
            controller.signal,
            deps.providerFetch ?? globalThis.fetch,
          )
        : plan(input, apiKey, secrets, controller.signal, deps.providerFetch ?? globalThis.fetch)),
    );
  } finally {
    clearTimeout(deadline);
    clearTimeout(bodyDeadline);
    request.signal.removeEventListener('abort', abort);
  }
}

export async function handleInstallerRequest(
  request: Request,
  config: PublicConfig,
  env: InstallerEnv,
  deps: InstallerDependencies = {},
): Promise<Response> {
  const started = Date.now();
  let errorCode: string | undefined;
  let response: Response;
  try {
    response = await serve(request, config, env, deps);
  } catch (error) {
    // Never serialize/log exception messages, SDK errors, source, proposal, tokens or headers.
    errorCode = error instanceof InstallerError ? error.code : 'installer_unavailable';
    response =
      error instanceof InstallerError
        ? error.status === 401
          ? invalidTokenResponse(config)
          : jsonResponse(error.status, { error: error.code })
        : jsonResponse(503, { error: 'installer_unavailable' });
  }
  // Only server-selected labels; never headers, body, token hashes or caught error text.
  deps.log?.(
    JSON.stringify({
      route: '/installer/plan',
      status: response.status,
      ...(errorCode === undefined ? {} : { errorcode: errorCode }),
      durationMs: Math.max(0, Date.now() - started),
    }),
  );
  const origin = request.headers.get('origin');
  return withHeaders(response, {
    'Cache-Control': 'no-store',
    ...(origin !== null && isAllowedOrigin(origin)
      ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
          Vary: 'Origin',
        }
      : {}),
  });
}
