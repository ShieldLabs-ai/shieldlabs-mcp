import { defineConfig } from 'tsup';

// One executable ESM bundle. @shieldlabs/node is bundled into it, so the published package only
// depends on the MCP SDK and zod at runtime.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  noExternal: ['@shieldlabs/node'],
  sourcemap: false,
  dts: false,
  clean: true,
  splitting: false,
  treeshake: true,
  removeNodeProtocol: false,
});
