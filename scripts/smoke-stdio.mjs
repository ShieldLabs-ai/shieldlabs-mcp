#!/usr/bin/env node
// Smoke test of the built package over stdio: starts the fake History API, spawns dist/index.js
// the way an MCP client does, then lists and calls tools, resources and prompts.
//
//   npm run build && node scripts/smoke-stdio.mjs
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  createMockApi,
  loadDataset,
  MOCK_API_KEY,
  MOCK_DOMAIN,
  MOCK_SECRET_KEY,
} from './mock-history-api.mjs';

const entry =
  process.argv[2] === undefined
    ? fileURLToPath(new URL('../dist/index.js', import.meta.url))
    : resolve(process.argv[2]);
const clients = new Set();
const stderrChunks = [];
const rawPublicKey = '0123456789abcdef0123456789abcdef';
const rawSecretKey = 'unconfigured-upstream-secret-fixture';

async function startMockApi() {
  const dataset = loadDataset();
  const api = createMockApi(dataset);
  let profileCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/profile') profileCalls++;
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
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    injectRawProfile() {
      dataset.profile.PublicKey = rawPublicKey;
      dataset.profile.Secret = rawSecretKey;
      profileCalls = 0;
    },
    profileCalls: () => profileCalls,
  };
}

async function connect(env, args = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, '--offline', ...args],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'shieldlabs-mcp-smoke', version: '1.0.0' });
  transport.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));
  clients.add(client);
  await client.connect(transport);
  return client;
}

const json = (result) => JSON.parse(result.content[0].text);

const api = await startMockApi();
const { server, base } = api;
try {
  const env = {
    SHIELDLABS_API_KEY: MOCK_API_KEY,
    SHIELDLABS_API_BASE_URL: base,
    SHIELDLABS_SECRET_KEY: MOCK_SECRET_KEY,
    SHIELDLABS_DOMAIN: MOCK_DOMAIN,
    SHIELDLABS_MANAGEMENT_BASE_URL: base,
  };
  const client = await connect(env);
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

  api.injectRawProfile();
  const profileClient = await connect(env);
  const outputs = await Promise.all(
    ['json', 'markdown', 'json', 'markdown'].map((response_format) =>
      profileClient.callTool({
        name: 'shieldlabs_get_domain_profile',
        arguments: { response_format },
      }),
    ),
  );
  const cached = await profileClient.callTool({
    name: 'shieldlabs_get_domain_profile',
    arguments: {},
  });
  assert.equal(cached.structuredContent.from_cache, true);
  assert.equal(api.profileCalls(), 1);
  for (const output of [...outputs, cached]) {
    assert.notEqual(output.isError, true);
    assert.equal(output.structuredContent.public_key_masked, '[redacted]');
    assert.equal(output.structuredContent.secret_key_masked, '[redacted]');
    assert.ok(!JSON.stringify(output).includes(rawPublicKey));
    assert.ok(!JSON.stringify(output).includes(rawSecretKey));
  }
  await profileClient.close();
  console.log('Profile masking: concurrent text/structured results and cache passed.');

  const limited = await connect(env, ['--tools', 'current_time']);
  assert.deepEqual(
    (await limited.listTools()).tools.map((tool) => tool.name),
    ['shieldlabs_current_time'],
  );
  const limitedGuide = await limited.getPrompt({ name: 'integrate_shieldlabs' });
  assert.ok(!JSON.stringify(limitedGuide).includes('shieldlabs_get_identification'));
  assert.ok(limitedGuide.messages[0].content.text.includes('identifications.get(requestId)'));
  const denied = await limited.callTool({ name: 'shieldlabs_get_identification', arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal((await limited.listResourceTemplates()).resourceTemplates.length, 0);
  await limited.close();
  console.log('Allowlist: setup prompt, hidden tool rejection and resources passed.');
  for (const secret of [MOCK_API_KEY, MOCK_SECRET_KEY, rawPublicKey, rawSecretKey]) {
    assert.ok(!stderrChunks.join('').includes(secret));
  }
  console.log('Smoke test passed.');
} finally {
  await Promise.all([...clients].map((client) => client.close()));
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
