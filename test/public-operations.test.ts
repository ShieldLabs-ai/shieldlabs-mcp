import { handlePublicRequest } from '../src/public/handler.js';
import { TokenCache } from '../src/public/token.js';
import { operationsSuite } from './operations-suite.js';
import { SIGNING_SECRET, UPSTREAM } from './operations-backend.js';

operationsSuite((backend) => {
  const logs: string[] = [];
  const config = {
    portalUrl: UPSTREAM,
    authIssuer: UPSTREAM,
    publicOrigin: 'https://dev.mcp.shieldlabs.ai',
    gatewayKey: { kid: 'k1', secret: SIGNING_SECRET },
  };
  const deps = {
    cache: new TokenCache(),
    fetch: backend.fetch,
    log: (line: string) => logs.push(line),
  };
  return {
    logs,
    fetch: (input, init) => handlePublicRequest(new Request(input, init), config, deps),
  };
});
