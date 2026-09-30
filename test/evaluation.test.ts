import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRows, MOCK_PROFILE } from '../scripts/generate-mock-data.mjs';
import { loadDataset } from '../scripts/mock-history-api.mjs';
import { TOOL_NAMES } from '../src/constants.js';
import { callJson, connect, type Connected } from './helpers.js';

interface QaPair {
  question: string;
  answer: string;
}

const xml = readFileSync(fileURLToPath(new URL('../evaluation.xml', import.meta.url)), 'utf8');

function parseEvaluation(text: string): QaPair[] {
  const pairs = [
    ...text.matchAll(
      /<qa_pair>\s*<question>([\s\S]*?)<\/question>\s*<answer>([\s\S]*?)<\/answer>\s*<\/qa_pair>/g,
    ),
  ];
  return pairs.map((match) => ({ question: match[1]!.trim(), answer: match[2]!.trim() }));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const HID = /\b[0-9a-f]{64}\b/;

function uuidIn(question: string): string {
  return question.match(UUID)![0];
}

function hidIn(question: string): string {
  return question.match(HID)![0];
}

async function identification(client: Client, requestId: string) {
  return (await callJson(client, TOOL_NAMES.getIdentification, { request_id: requestId }))
    .identification;
}

async function summary(client: Client, type: string, value: string) {
  return (await callJson(client, TOOL_NAMES.summarizeEntity, { type, value, max_items: 500 }))
    .summary;
}

/** Every identification for one identifier, following next_offset like an agent would. */
async function everyIdentification(client: Client, type: string, value: string) {
  const items: any[] = [];
  let offset = 0;
  for (;;) {
    const page = await callJson(client, TOOL_NAMES.searchHistory, {
      type,
      value,
      limit: 10,
      offset,
    });
    items.push(...page.identifications);
    if (!page.has_more) return items;
    offset = page.next_offset;
  }
}

const byTime = (a: any, b: any) => Date.parse(a.observed_at) - Date.parse(b.observed_at);

/** How an agent can answer each question with the tools of this server. */
const SOLVERS: ((client: Client, question: string) => Promise<string>)[] = [
  async (client, q) => {
    const item = await identification(client, uuidIn(q));
    return String((await summary(client, 'device_id', item.device_id)).users.distinct);
  },
  async (client, q) => {
    const item = await identification(client, uuidIn(q));
    return String((await summary(client, 'user_hid', item.user_hid)).devices.distinct);
  },
  async (client, q) => (await summary(client, 'user_hid', hidIn(q))).countries.top[0].value,
  async (client, q) => {
    const items = (await everyIdentification(client, 'user_hid', hidIn(q))).sort(byTime);
    const gaps = items
      .slice(1)
      .map((item, index) => [items[index], item])
      .filter(([a, b]) => a.public_ip.country !== b.public_ip.country)
      .map(([a, b]) => (Date.parse(b.observed_at) - Date.parse(a.observed_at)) / 60_000);
    return String(Math.floor(Math.min(...gaps)));
  },
  async (client, q) => {
    const item = await identification(client, uuidIn(q));
    const types = (await summary(client, 'user_hid', item.user_hid)).connection_types.top;
    return String(types.find((entry: any) => entry.value === 'vpn').count);
  },
  async (client, q) => {
    const item = await identification(client, uuidIn(q));
    return String((await summary(client, 'ip', item.public_ip.ip)).risk.rate_limit_markers);
  },
  async (client, q) => {
    const items = await everyIdentification(client, 'device_id', uuidIn(q));
    const riskiest = items.reduce((best, item) =>
      item.risk_score > best.risk_score ? item : best,
    );
    const explanation = await callJson(client, TOOL_NAMES.explainRiskScore, {
      request_id: riskiest.request_id,
    });
    return explanation.signals.reduce((best: any, s: any) => (s.weight > best.weight ? s : best))
      .name;
  },
  async (client, q) => {
    const item = await identification(client, uuidIn(q));
    const flagged = (await everyIdentification(client, 'visitor_id', item.visitor_id))
      .filter((entry) => entry.detection_flags.suspicious_paid_click)
      .sort(byTime);
    return flagged[0].traffic_source.utm_campaign;
  },
  async (client, q) => {
    const payload = q.match(/this body: (\{.*?\}) together/)![1]!;
    const header = q.match(/X-Shield-Signature: (sha256=[0-9a-f]{64})/)![1]!;
    const secret = q.match(/(whsec_[0-9a-f]+)/)![1]!;
    const output = await callJson(client, TOOL_NAMES.verifyWebhookSignature, {
      payload,
      signature_header: header,
      secret,
    });
    return output.valid ? 'True' : 'False';
  },
  async (client, q) => {
    const fromBrazil = (await everyIdentification(client, 'user_hid', hidIn(q)))
      .filter((item) => item.public_ip.country === 'Brazil')
      .sort(byTime);
    return new Date(fromBrazil[0].observed_at).toISOString().slice(0, 16).replace('T', ' ');
  },
];

describe('evaluation.xml', () => {
  const pairs = parseEvaluation(xml);
  let connected: Connected;

  beforeAll(async () => {
    connected = await connect();
  });

  afterAll(async () => {
    await connected.close();
  });

  it('has ten questions with explicit answer formats', () => {
    expect(pairs).toHaveLength(10);
    for (const pair of pairs) {
      expect(pair.question).toMatch(/Answer (with|in|True)/);
      expect(pair.answer).not.toBe('');
    }
  });

  pairs.forEach((pair, index) => {
    it(`question ${index + 1} is answerable with the tools on the mock dataset: ${pair.answer}`, async () => {
      await expect(SOLVERS[index]!(connected.client, pair.question)).resolves.toBe(pair.answer);
    });
  });
});

describe('mock dataset', () => {
  it('matches the generator output (run node scripts/generate-mock-data.mjs after changing it)', () => {
    const committed = loadDataset();
    expect(committed.rows).toEqual(buildRows());
    expect(committed.profile).toEqual(MOCK_PROFILE);
  });
});
