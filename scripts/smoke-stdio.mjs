#!/usr/bin/env node
// Smoke test of the built package over stdio: starts the fake History API, spawns dist/index.js
// the way an MCP client does, then lists and calls tools, resources and prompts.
//
//   npm run build && node scripts/smoke-stdio.mjs
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createMockApi,
  loadDataset,
  MOCK_API_KEY,
  MOCK_DOMAIN,
  MOCK_SECRET_KEY,
} from './mock-history-api.mjs';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

async function startMockApi() {
  const api = createMockApi(loadDataset());
  const server = createServer((req, res) => {
    const reply = api.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      header: (name) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      },
    });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--offline'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'shieldlabs-mcp-smoke', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

const json = (result) => JSON.parse(result.content[0].text);

const { server, base } = await startMockApi();
try {
  const client = await connect({
    SHIELDLABS_API_KEY: MOCK_API_KEY,
    SHIELDLABS_API_BASE_URL: base,
    SHIELDLABS_SECRET_KEY: MOCK_SECRET_KEY,
    SHIELDLABS_DOMAIN: MOCK_DOMAIN,
    SHIELDLABS_MANAGEMENT_BASE_URL: base,
  });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  console.log(`tools/list: ${tools.map((tool) => tool.name).join(', ')}`);

  const page = json(
    await client.callTool({
      name: 'shieldlabs_search_history',
      arguments: { type: 'ip', value: '203.0.113.200', limit: 5, response_format: 'json' },
    }),
  );
  assert.equal(page.total, 5);
  console.log(`shieldlabs_search_history ip 203.0.113.200: total ${page.total}`);

  const first = page.identifications[0];
  const found = json(
    await client.callTool({
      name: 'shieldlabs_get_identification',
      arguments: { request_id: first.request_id, response_format: 'json' },
    }),
  );
  assert.equal(found.identification.request_id, first.request_id);
  console.log(
    `shieldlabs_get_identification: Risk Score ${found.identification.risk_score} (${found.identification.risk_band})`,
  );

  const summary = json(
    await client.callTool({
      name: 'shieldlabs_summarize_entity',
      arguments: { type: 'ip', value: '203.0.113.200', response_format: 'json' },
    }),
  );
  assert.equal(summary.summary.risk.rate_limit_markers, 3);
  console.log(
    `shieldlabs_summarize_entity: ${summary.summary.risk.rate_limit_markers} rate-limit markers`,
  );

  const explanation = json(
    await client.callTool({
      name: 'shieldlabs_explain_risk_score',
      arguments: { request_id: page.identifications.at(-1).request_id, response_format: 'json' },
    }),
  );
  console.log(
    `shieldlabs_explain_risk_score: ${explanation.risk_band}, ${explanation.signals.length} signals`,
  );

  const profile = json(
    await client.callTool({
      name: 'shieldlabs_get_domain_profile',
      arguments: { response_format: 'json' },
    }),
  );
  assert.equal(profile.remaining_identifications, 148230);
  console.log(
    `shieldlabs_get_domain_profile: ${profile.domain}, ${profile.remaining_identifications} remaining`,
  );

  const { resources } = await client.listResources();
  const { prompts } = await client.listPrompts();
  const guide = await client.getPrompt({ name: 'integrate_shieldlabs' });
  assert.ok(guide.messages[0].content.text.includes('built-in guide'));
  console.log(
    `resources/list: ${resources.length}; prompts/list: ${prompts.map((p) => p.name).join(', ')}`,
  );
  await client.close();

  const offline = await connect({});
  const offlineTools = (await offline.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(offlineTools, [
    'shieldlabs_explain_risk_score',
    'shieldlabs_verify_webhook_signature',
    'shieldlabs_current_time',
  ]);
  console.log(`without SHIELDLABS_API_KEY: ${offlineTools.join(', ')}`);
  await offline.close();
  console.log('Smoke test passed.');
} finally {
  server.close();
}
