#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr })
  .then((result) => {
    if ('exitCode' in result) {
      process.exitCode = result.exitCode;
      return;
    }
    const { started } = result;
    const shutdown = (): void => {
      started.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (started.mode === 'stdio') process.stdin.once('end', shutdown);
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `[shieldlabs-mcp] Failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
