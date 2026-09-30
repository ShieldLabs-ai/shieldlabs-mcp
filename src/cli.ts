import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ShieldLabsError } from '@shieldlabs/node';
import { buildServerConfig, HELP_TEXT, parseArgs, UsageError, type CliOptions } from './config.js';
import { SERVER_VERSION, TOOL_NAMES } from './constants.js';
import { createContext, redact, type ContextDependencies, type ServerContext } from './context.js';
import { generateToken, isLoopbackHost, startHttpServer, type RunningHttpServer } from './http.js';
import { createLogger, type Logger } from './log.js';
import { createShieldLabsServer } from './server.js';

export interface MainOptions {
  env: Readonly<Record<string, string | undefined>>;
  stdout: Writable;
  stderr: Writable;
  /** stdin for the stdio transport. Default: process.stdin. */
  stdin?: Readable;
  deps?: ContextDependencies;
}

/** A running server started by main(). */
export interface Started {
  mode: 'stdio' | 'http';
  context: ServerContext;
  http?: RunningHttpServer;
  close(): Promise<void>;
}

/** Result of main(): an exit code for one-shot commands, or the running server. */
export type MainResult = { exitCode: number } | { started: Started };

function describeConfig(ctx: ServerContext): string {
  const history =
    ctx.history === undefined
      ? 'History API not configured (offline tools only)'
      : 'History API configured';
  const management =
    ctx.management === undefined ? 'Management API not configured' : 'Management API configured';
  return `${history}; ${management}; tools: ${[...ctx.enabledTools].join(', ') || 'none'}`;
}

function warnIncompleteManagement(ctx: ServerContext, log: Logger): void {
  const { secretKey, domain } = ctx.config;
  if ((secretKey === undefined) !== (domain === undefined)) {
    const missing = secretKey === undefined ? 'SHIELDLABS_SECRET_KEY' : 'SHIELDLABS_DOMAIN';
    log(
      `${missing} is not set, so the Management API (shieldlabs_get_domain_profile) is disabled. Set both SHIELDLABS_SECRET_KEY and SHIELDLABS_DOMAIN to enable it.`,
    );
  }
}

function warnUnavailableTools(ctx: ServerContext, log: Logger): void {
  for (const tool of ctx.unavailableRequestedTools) {
    const needs =
      tool === TOOL_NAMES.getDomainProfile
        ? 'SHIELDLABS_SECRET_KEY and SHIELDLABS_DOMAIN'
        : 'SHIELDLABS_API_KEY';
    log(`--tools lists ${tool}, which needs ${needs}; it is not exposed.`);
  }
}

/** Shorter bearer tokens can be guessed; a generated token has 43 characters. */
export const MIN_TOKEN_LENGTH = 32;

/** Warns when the configured bearer token is short; louder when other machines can reach it. */
export function warnShortToken(token: string, host: string, log: Logger): void {
  if (token.length >= MIN_TOKEN_LENGTH) return;
  const length = `${token.length} character${token.length === 1 ? '' : 's'}`;
  const advice = `Use a random value of at least ${MIN_TOKEN_LENGTH} characters, for example the output of: openssl rand -hex 32`;
  if (isLoopbackHost(host)) {
    log(`SHIELDLABS_MCP_TOKEN has only ${length}. ${advice}.`);
  } else {
    log(
      `WARNING: SHIELDLABS_MCP_TOKEN has only ${length} and the server is bound to ${host}, where other machines can try to guess it. ${advice}.`,
    );
  }
}

async function startHttp(options: CliOptions, ctx: ServerContext, log: Logger): Promise<Started> {
  let token = ctx.config.mcpToken;
  if (token === undefined) {
    token = generateToken();
    log(
      `SHIELDLABS_MCP_TOKEN is not set. Generated a bearer token for this run (it changes on every start): ${token}`,
    );
  } else {
    warnShortToken(token, options.host, log);
  }
  const http = await startHttpServer({
    host: options.host,
    port: options.port,
    token,
    allowedOrigins: options.allowedOrigins,
    createMcpServer: () => createShieldLabsServer(ctx),
    log,
  });
  log(
    `ShieldLabs MCP server ${SERVER_VERSION} listening on ${http.url} (streamable HTTP, bearer token required). ${describeConfig(ctx)}`,
  );
  if (!isLoopbackHost(options.host)) {
    log(
      `Bound to ${options.host}: other machines can reach this port. Keep the token secret and put TLS in front of the server.`,
    );
  }
  return { mode: 'http', context: ctx, http, close: () => http.close() };
}

async function startStdio(
  ctx: ServerContext,
  log: Logger,
  stdin: Readable | undefined,
  stdout: Writable,
): Promise<Started> {
  const server = createShieldLabsServer(ctx);
  const transport = new StdioServerTransport(stdin ?? process.stdin, stdout);
  await server.connect(transport);
  log(`ShieldLabs MCP server ${SERVER_VERSION} running on stdio. ${describeConfig(ctx)}`);
  return { mode: 'stdio', context: ctx, close: () => server.close() };
}

/**
 * Entry point. Returns an exit code for --help, --version and configuration errors, or the
 * running server. Never writes to stdout except for --help and --version (stdout carries the
 * protocol on stdio).
 */
export async function main(argv: readonly string[], options: MainOptions): Promise<MainResult> {
  const log = createLogger(options.stderr);
  let cli: CliOptions;
  try {
    cli = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      log(`${error.message} Run shieldlabs-mcp --help for usage.`);
      return { exitCode: 2 };
    }
    throw error;
  }
  if (cli.help) {
    options.stdout.write(HELP_TEXT);
    return { exitCode: 0 };
  }
  if (cli.version) {
    options.stdout.write(`${SERVER_VERSION}\n`);
    return { exitCode: 0 };
  }

  // Over HTTP one server can serve several clients: the setup prompt never fetches remote text there.
  const config = buildServerConfig(options.env, {
    tools: cli.tools,
    offline: cli.offline || cli.transport === 'http',
  });
  let ctx: ServerContext;
  try {
    ctx = createContext(config, options.deps);
  } catch (error) {
    if (error instanceof ShieldLabsError) {
      log(`Configuration error. ${redact({ secrets: [] }, error.message)}`);
      return { exitCode: 2 };
    }
    throw error;
  }
  warnUnavailableTools(ctx, log);
  warnIncompleteManagement(ctx, log);
  if (ctx.history === undefined) {
    log(
      'SHIELDLABS_API_KEY is not set: starting with offline tools only. Set it to the Private API Key (sec_...) of the domain to read identifications.',
    );
  }

  if (cli.transport === 'stdio') {
    return { started: await startStdio(ctx, log, options.stdin, options.stdout) };
  }
  try {
    return { started: await startHttp(cli, ctx, log) };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'EADDRINUSE' || code === 'EACCES' || code === 'EADDRNOTAVAIL') {
      log(
        `Cannot listen on ${cli.host}:${cli.port} (${String(code)}). Choose another port with --port or another address with --host.`,
      );
      return { exitCode: 1 };
    }
    throw error;
  }
}
