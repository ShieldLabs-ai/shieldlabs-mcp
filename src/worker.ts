import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { publicConfigFromEnv, type PublicConfig, type PublicEnv } from './public/config.js';
import { handlePublicRequest } from './public/handler.js';
import type { RateLimiter } from './public/rate-limit.js';
import { formatRequestLog, routeOf, safeId } from './public/request-log.js';
import { serverErrorResponse } from './public/responses.js';
import { TokenCache } from './public/token.js';

/** Bindings of the Worker: the variables and the secret of wrangler.jsonc, and the rate limiters. */
export interface WorkerEnv extends PublicEnv {
  RL_TOKEN?: RateLimiter;
  RL_ANON?: RateLimiter;
  RL_TOKEN_CHECK?: RateLimiter;
}

/** The part of the Workers ExecutionContext this entry uses. */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Shared by the requests of one isolate: the cache holds accepted tokens by their SHA-256 only,
// and the validator keeps no state.
const cache = new TokenCache();
const jsonSchemaValidator = new CfWorkerJsonSchemaValidator();

/** Workers Logs collects console output; every line is one JSON object. */
function log(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
}

/** The public (hosted, multi-tenant) mode on Cloudflare Workers. */
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    let config: PublicConfig;
    try {
      config = publicConfigFromEnv(env);
    } catch (error) {
      log(
        formatRequestLog({
          ts: new Date().toISOString(),
          rid: safeId(request.headers.get('cf-ray')) ?? crypto.randomUUID(),
          route: routeOf(new URL(request.url).pathname),
          status: 500,
          error: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return serverErrorResponse();
    }
    return handlePublicRequest(request, config, {
      cache,
      jsonSchemaValidator,
      rateLimiters: { token: env.RL_TOKEN, anon: env.RL_ANON, tokenCheck: env.RL_TOKEN_CHECK },
      waitUntil: (promise) => ctx.waitUntil(promise),
      log,
    });
  },
};
