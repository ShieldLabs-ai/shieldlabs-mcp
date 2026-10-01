import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Worker runtime tests (npm run test:worker): the Worker entry runs in workerd with the dev
// settings of wrangler.jsonc. The account API origin points at a host the tests serve themselves,
// through a fake account API installed as the global fetch; nothing leaves the machine.
export default defineConfig({
  // The pool transforms every dependency, and Vite warns about each source map of the SDK that
  // points to sources it does not ship.
  logLevel: 'error',
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          SHIELDLABS_PORTAL_URL: 'https://account.example.test',
          MCP_GATEWAY_KEY: 'k1:gateway-test-secret-0123456789abcdef',
        },
      },
    }),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    // The Worker writes one log line per request.
    silent: 'passed-only',
    testTimeout: 30_000,
  },
});
