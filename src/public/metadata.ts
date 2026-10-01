import { DOCS_URL, MCP_HTTP_PATH } from '../constants.js';
import type { PublicConfig } from './config.js';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';

/**
 * Where the protected resource metadata (RFC 9728) is served: the path derived from the /mcp
 * resource, and the root path that some clients try first. Both serve the same document.
 */
export const METADATA_PATHS: readonly string[] = [`${WELL_KNOWN}${MCP_HTTP_PATH}`, WELL_KNOWN];

/** The resource identifier: the URL users enter, including /mcp. */
export function resourceUrl(config: PublicConfig): string {
  return `${config.publicOrigin}${MCP_HTTP_PATH}`;
}

/** URL of the metadata document, as the WWW-Authenticate challenge names it. */
export function metadataUrl(config: PublicConfig): string {
  return `${config.publicOrigin}${WELL_KNOWN}${MCP_HTTP_PATH}`;
}

/**
 * The protected resource metadata document. It names no scopes: the ShieldLabs authorization
 * server has none, and the audience of the token is what limits it to this server.
 */
export function protectedResourceMetadata(config: PublicConfig) {
  return {
    resource: resourceUrl(config),
    authorization_servers: [config.authIssuer],
    bearer_methods_supported: ['header'],
    resource_name: 'ShieldLabs',
    resource_documentation: DOCS_URL,
  };
}

/**
 * The WWW-Authenticate value of a 401. Without an error it starts the sign-in; with
 * invalid_token the client refreshes its token or signs in again.
 */
export function challenge(config: PublicConfig, error?: 'invalid_token'): string {
  const base = `Bearer resource_metadata="${metadataUrl(config)}"`;
  return error === undefined ? base : `${base}, error="${error}"`;
}
