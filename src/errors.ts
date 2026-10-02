import {
  AuthenticationError,
  ConnectionError,
  NotFoundError,
  QuotaExceededError,
  RateLimitError,
  ServerError,
  ShieldLabsError,
  TimeoutError,
  ValidationError,
  ApiError,
} from '@shieldlabs-ai/node';
import { APP_URL, SUPPORT_EMAIL } from './constants.js';
import { redact, type ServerContext } from './context.js';

/** An error whose message is already written for the model and safe to return as is. */
export class ToolInputError extends Error {
  override name = 'ToolInputError';
}

export type ApiSurface = 'history' | 'management';

function retryAfterText(error: RateLimitError): string {
  return error.retryAfter !== undefined ? ` The server asked to wait ${error.retryAfter} s.` : '';
}

/**
 * Turns any error into an actionable message for the model. Messages name the fix (which setting
 * to check, how long to wait) and never contain keys or secrets.
 */
export function describeError(
  ctx: Pick<ServerContext, 'secrets'>,
  error: unknown,
  surface: ApiSurface = 'history',
): string {
  const history = surface === 'history';
  let message: string;

  if (error instanceof ToolInputError) {
    message = `Error: ${error.message}`;
  } else if (error instanceof ValidationError) {
    message = `Error: invalid input. ${error.message}`;
  } else if (error instanceof AuthenticationError) {
    message = history
      ? `Error: the History API rejected the key (HTTP ${error.status}). Check that SHIELDLABS_API_KEY is the Private API Key (sec_...) of the domain you are investigating, not its Public Key or Secret Key, and that the domain is enabled in the analytics dashboard (${APP_URL}). Fix the MCP client configuration and restart the server; retrying will not help.`
      : `Error: the Management API rejected the credentials (HTTP ${error.status}). Check SHIELDLABS_SECRET_KEY and that SHIELDLABS_DOMAIN is exactly the registered domain (for example example.com), then restart the server; retrying will not help.`;
  } else if (error instanceof RateLimitError) {
    message = history
      ? `Error: the History API rate limit was reached (HTTP 429). It allows about 15 requests per second per domain, shared with the site's own backend. Wait a few seconds and retry, and prefer one shieldlabs_summarize_entity call with a modest max_items over many searches.${retryAfterText(error)}`
      : `Error: the Management API rate limit was reached (HTTP 429). It allows about 15 calls per minute per IP and then blocks the IP for 10 minutes. Wait at least 10 minutes before calling shieldlabs_get_domain_profile again.${retryAfterText(error)}`;
  } else if (error instanceof QuotaExceededError) {
    message = `Error: the account has no identifications left (HTTP 402). Check the plan in the analytics dashboard (${APP_URL}).`;
  } else if (error instanceof NotFoundError) {
    message = history
      ? 'Error: the History API answered 404, which usually means a wrong base URL. SHIELDLABS_API_BASE_URL must be the origin only, for example https://account.shieldlabs.ai.'
      : 'Error: the Management API answered 404, which usually means a wrong base URL. SHIELDLABS_MANAGEMENT_BASE_URL must be the origin only, for example https://api.shieldlabs.ai.';
  } else if (error instanceof ServerError) {
    message = `Error: the ShieldLabs API had a server error (HTTP ${error.status}). Retry in a moment; if it persists, contact ${SUPPORT_EMAIL}.`;
  } else if (error instanceof TimeoutError) {
    message = 'Error: the ShieldLabs API did not answer in time. Retry in a moment.';
  } else if (error instanceof ConnectionError) {
    message = `Error: could not reach the ShieldLabs API. Check network access from the machine running this server and the base URL settings (SHIELDLABS_API_BASE_URL, SHIELDLABS_MANAGEMENT_BASE_URL).`;
  } else if (error instanceof ApiError) {
    // Management errors can echo profile credentials we do not know from configuration.
    message = history
      ? `Error: the ShieldLabs API answered HTTP ${error.status}. ${error.message}`
      : `Error: the Management API answered HTTP ${error.status}. Check SHIELDLABS_MANAGEMENT_BASE_URL and the profile settings; if it persists, contact ${SUPPORT_EMAIL}.`;
  } else if (error instanceof ShieldLabsError) {
    message = `Error: ${error.message}`;
  } else {
    const text = error instanceof Error ? error.message : String(error);
    message = `Error: unexpected failure: ${text}`;
  }
  return redact(ctx, message);
}
