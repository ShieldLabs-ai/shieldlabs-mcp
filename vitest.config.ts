import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Worker runtime tests run in workerd: npm run test:worker (vitest.worker.config.ts).
    exclude: [...configDefaults.exclude, 'test/worker/**'],
    environment: 'node',
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The executable wrapper only calls main(); main() itself is covered.
      exclude: ['src/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 85,
      },
    },
  },
});
