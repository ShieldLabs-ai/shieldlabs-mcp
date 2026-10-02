import { SELF } from 'cloudflare:test';
import { vi } from 'vitest';
import { operationsSuite } from '../operations-suite.js';
import type { PortalFetch } from '../../src/public/portal.js';

operationsSuite((backend) => {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    backend.fetch(
      input instanceof Request ? input.url : input.toString(),
      init as Parameters<PortalFetch>[1],
    ),
  );
  const logs: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(line);
  });
  return { logs, fetch: (input, init) => SELF.fetch(input, init) };
});
