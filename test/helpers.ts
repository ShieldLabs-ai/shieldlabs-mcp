import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { FetchLike, FetchRequestInit } from '@shieldlabs/node';
import { vi } from 'vitest';
import {
  createMockApi,
  loadDataset,
  MOCK_API_KEY,
  MOCK_DOMAIN,
  MOCK_SECRET_KEY,
} from '../scripts/mock-history-api.mjs';
import { buildServerConfig } from '../src/config.js';
import type { ToolName } from '../src/constants.js';
import { createContext, type ContextDependencies, type ServerContext } from '../src/context.js';
import { createShieldLabsServer } from '../src/server.js';

export { MOCK_API_KEY, MOCK_DOMAIN, MOCK_SECRET_KEY };

export const API_BASE = 'https://account.example.test';
export const MANAGEMENT_BASE = 'https://api.example.test';

/** Environment with every ShieldLabs API configured against the fake API. */
export const FULL_ENV = {
  SHIELDLABS_API_KEY: MOCK_API_KEY,
  SHIELDLABS_API_BASE_URL: API_BASE,
  SHIELDLABS_SECRET_KEY: MOCK_SECRET_KEY,
  SHIELDLABS_DOMAIN: MOCK_DOMAIN,
  SHIELDLABS_MANAGEMENT_BASE_URL: MANAGEMENT_BASE,
  SHIELDLABS_WEBHOOK_SECRET: 'whsec_00112233445566778899aabbccddeeff',
};

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as T;
}

export function fixtureText(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

export interface FetchCall {
  url: string;
  init: FetchRequestInit;
}

function headerLookup(init: FetchRequestInit) {
  return (name: string): string | undefined => {
    const entry = Object.entries(init.headers).find(([key]) => key.toLowerCase() === name);
    return entry?.[1];
  };
}

/** A fetch that serves the fake API with a dataset (the mock dataset by default). */
export function mockApiFetch(dataset = loadDataset()) {
  const api = createMockApi(dataset);
  const calls: FetchCall[] = [];
  const fetch = vi.fn((url: string, init: FetchRequestInit) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const reply = api.handle({
      method: init.method,
      url: `${parsed.pathname}${parsed.search}`,
      header: headerLookup(init),
    });
    return Promise.resolve(
      new Response(reply.body === '' ? null : reply.body, {
        status: reply.status,
        headers: reply.headers,
      }),
    );
  });
  return { fetch: fetch as unknown as FetchLike & typeof fetch, calls };
}

/** A fetch that answers every request with the same status and body. */
export function statusFetch(
  status: number,
  body: string,
  contentType: string | null = 'application/json',
  headers: Record<string, string> = {},
) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn((url: string, init: FetchRequestInit) => {
    calls.push({ url, init });
    const responseHeaders = new Headers(headers);
    if (contentType !== null) responseHeaders.set('content-type', contentType);
    return Promise.resolve(
      new Response(body === '' ? null : body, { status, headers: responseHeaders }),
    );
  });
  return { fetch: fetch as unknown as FetchLike, calls };
}

/** A fetch whose every call fails like a network error. */
export function failingFetch(message = 'connect ECONNREFUSED 127.0.0.1:1') {
  return vi.fn(() => Promise.reject(new TypeError(message))) as unknown as FetchLike;
}

export interface Connected {
  client: Client;
  ctx: ServerContext;
  close(): Promise<void>;
}

/** A History request budget that never makes a request wait. */
export const UNLIMITED_BUDGET = { maxConcurrent: Infinity, perSecond: Infinity };

/** Connects an in-memory MCP client to a server built from `env`. */
export async function connect(
  env: Record<string, string> = FULL_ENV,
  deps: ContextDependencies = {},
  cli: { tools?: ToolName[]; offline?: boolean } = {},
): Promise<Connected> {
  const config = buildServerConfig(env, { tools: cli.tools, offline: cli.offline ?? true });
  const ctx = createContext(config, {
    apiFetch: mockApiFetch().fetch,
    maxRetries: 0,
    waitTimeoutMs: 300,
    // Tests of the tools do not wait for the request budget (test/history-fetch.test.ts covers it).
    historyBudget: UNLIMITED_BUDGET,
    ...deps,
  });
  const server = createShieldLabsServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'shieldlabs-mcp-tests', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    ctx,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

/** Calls a tool with response_format=json and returns the parsed text (asserting no error). */
export async function callJson<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await callTool(client, name, { ...args, response_format: 'json' });
  if (result.isError === true) throw new Error(`tool error: ${textOf(result)}`);
  return JSON.parse(textOf(result)) as T;
}

/** Mock dataset rows (History API shape). */
export function mockRows(): Record<string, any>[] {
  return loadDataset().rows as Record<string, any>[];
}
