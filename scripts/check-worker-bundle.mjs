#!/usr/bin/env node
// Bundles the Worker the way `wrangler deploy` does, without uploading it, and checks the bundle:
// it must not import any Node.js built-in module (the Worker uses Web APIs only) and must stay
// under the size limit of the smallest Workers plan.
//
//   node scripts/check-worker-bundle.mjs [--outdir dist-worker]
//
// Without --outdir the bundle goes to a temporary directory that is removed afterwards.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Compressed size limit of the Workers Free plan; the Paid plan allows 10 MiB. */
const MAX_GZIP_BYTES = 3 * 1024 * 1024;

const root = fileURLToPath(new URL('..', import.meta.url));
const flag = process.argv.indexOf('--outdir');
const outdir =
  flag === -1 ? mkdtempSync(join(tmpdir(), 'shieldlabs-mcp-worker-')) : process.argv[flag + 1];
if (outdir === undefined) {
  process.stderr.write('--outdir needs a directory.\n');
  process.exit(2);
}

const kib = (bytes) => `${(bytes / 1024).toFixed(2)} KiB`;
const builtins = new Set(builtinModules);

/** Bundles the Worker into `outdir` and returns what is wrong with the bundle, if anything. */
function check() {
  const metafile = join(outdir, 'meta.json');
  // Every environment of wrangler.jsonc bundles the same code; dev is the one deployed first.
  const result = spawnSync(
    join(root, 'node_modules', '.bin', 'wrangler'),
    ['deploy', '--dry-run', '--env', 'dev', '--outdir', outdir, '--metafile', metafile],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  if (result.status !== 0)
    return `${result.stdout}${result.stderr}wrangler deploy --dry-run failed.`;
  const meta = JSON.parse(readFileSync(metafile, 'utf8'));
  const [bundle, output] = Object.entries(meta.outputs).find(([path]) => path.endsWith('.js'));
  const nodeImports = output.imports
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('node:') || builtins.has(path));
  const bytes = readFileSync(join(root, bundle));
  const gzip = gzipSync(bytes).length;
  process.stdout.write(`Worker bundle: ${kib(bytes.length)}, ${kib(gzip)} gzip.\n`);
  if (nodeImports.length > 0) {
    return `The bundle imports Node.js built-in modules: ${nodeImports.join(', ')}.`;
  }
  if (gzip > MAX_GZIP_BYTES) return `The bundle is larger than ${kib(MAX_GZIP_BYTES)} gzip.`;
  process.stdout.write('No Node.js built-in module is imported.\n');
  return undefined;
}

try {
  const problem = check();
  if (problem !== undefined) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
  }
} finally {
  if (flag === -1) rmSync(outdir, { recursive: true, force: true });
}
