import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_PROFILE } from '../scripts/generate-mock-data.mjs';
import { CHARACTER_LIMIT, TOOL_NAMES } from '../src/constants.js';
import { enforceCharacterLimit, enforceJsonLimit, MAX_VALUE_LENGTH } from '../src/format.js';
import { respond } from '../src/tools/shared.js';
import {
  callTool,
  connect,
  fixture,
  FULL_ENV,
  mockApiFetch,
  textOf,
  type Connected,
} from './helpers.js';

let connected: Connected | undefined;

afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const historyPage = fixture('history-page.json');
const template = historyPage.data[0];
const LONG = 100_000;

function requestId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** History rows whose browser-reported values are far longer than any real one. */
function hostileRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    ...template,
    request_id: requestId(index),
    user_hid: `${index}${'u'.repeat(LONG)}`,
    entry_url: `https://shop.example.com/?q=${'a'.repeat(LONG)}`,
    utm_source: 's'.repeat(LONG),
    utm_campaign: 'c'.repeat(LONG),
  }));
}

function connectToRows(rows: Record<string, unknown>[]) {
  return connect(FULL_ENV, { apiFetch: mockApiFetch({ rows, profile: MOCK_PROFILE }).fetch });
}

/** Text and structured content both fit; json text is exactly the structured content. */
function expectWithinLimits(result: CallToolResult, format: 'markdown' | 'json'): void {
  expect(result.isError, textOf(result).slice(0, 300)).toBeFalsy();
  const text = textOf(result);
  expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
  if (format === 'json') expect(JSON.parse(text)).toEqual(result.structuredContent);
}

describe('response size limits', () => {
  it('cut long browser-reported values of one identification and list them', async () => {
    connected = await connectToRows(hostileRows(1));
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.getIdentification, {
        request_id: requestId(0),
        response_format: format,
      });
      expectWithinLimits(result, format);
      const item = (result.structuredContent as any).identification;
      expect(item.truncated_fields).toEqual([
        'user_hid',
        'traffic_source.landing_url',
        'traffic_source.utm_source',
        'traffic_source.utm_campaign',
      ]);
      expect(item.user_hid).toHaveLength(MAX_VALUE_LENGTH);
      expect(item.traffic_source.landing_url.startsWith('https://shop.example.com/?q=aaa')).toBe(
        true,
      );
      if (format === 'markdown') expect(textOf(result)).toContain('- Shortened by this server');
    }
  });

  it('keep search pages of oversized identifications within the limit in both formats', async () => {
    connected = await connectToRows(hostileRows(30));
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.searchHistory, {
        type: 'device_id',
        value: template.device_id,
        limit: 100,
        response_format: format,
      });
      expectWithinLimits(result, format);
      const page = result.structuredContent as any;
      expect(page.total).toBe(30);
      expect(page.count).toBeGreaterThanOrEqual(1);
      expect(page.count).toBeLessThan(30);
      expect(page.truncated).toBe(true);
      expect(page.next_offset).toBe(page.count);
    }
  });

  it('cut values by their size in JSON, so control characters and quotes cannot inflate them', async () => {
    const browserFields = (value: string) => ({
      user_hid: value,
      entry_url: value,
      referrer_domain: value,
      utm_source: value,
      utm_medium: value,
      utm_campaign: value,
      utm_content: value,
      utm_term: value,
    });
    const rows = [
      { ...template, request_id: requestId(0), ...browserFields('\u0001'.repeat(1_000)) },
      { ...template, request_id: requestId(1), ...browserFields('"\\'.repeat(1_000)) },
    ];
    connected = await connectToRows(rows);
    for (const index of [0, 1]) {
      for (const format of ['markdown', 'json'] as const) {
        const found = await callTool(connected.client, TOOL_NAMES.getIdentification, {
          request_id: requestId(index),
          response_format: format,
        });
        expectWithinLimits(found, format);
        const item = (found.structuredContent as any).identification;
        expect(item.truncated_fields).toContain('user_hid');
        expect(JSON.stringify(item.user_hid).length - 2).toBeLessThanOrEqual(MAX_VALUE_LENGTH);
        if (index === 0) expect(item.escaped_fields).toContain('traffic_source.utm_term');
        const search = await callTool(connected.client, TOOL_NAMES.searchHistory, {
          type: 'request_id',
          value: requestId(index),
          response_format: format,
        });
        expectWithinLimits(search, format);
        expect((search.structuredContent as any).count).toBe(1);
      }
    }
  });

  it('keep a summary of 500 identifications with distinct control-character User HIDs within the limit', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      ...template,
      request_id: requestId(index),
      user_hid: `${index}${'\u0001'.repeat(1_000)}`,
    }));
    connected = await connectToRows(rows);
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.summarizeEntity, {
        type: 'device_id',
        value: template.device_id,
        max_items: 500,
        response_format: format,
      });
      expectWithinLimits(result, format);
      const users = (result.structuredContent as any).summary.users;
      expect(users.distinct).toBe(500);
      expect(users.top).toHaveLength(10);
      for (const entry of users.top) {
        expect(entry.truncated).toBe(true);
        expect(JSON.stringify(entry.value).length - 2).toBeLessThanOrEqual(160);
      }
      if (format === 'markdown') expect(textOf(result)).toContain('(shortened)');
    }
  });

  it('keep summaries of many long User HIDs within the limit', async () => {
    connected = await connectToRows(hostileRows(30));
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.summarizeEntity, {
        type: 'device_id',
        value: template.device_id,
        response_format: format,
      });
      expectWithinLimits(result, format);
      const summary = (result.structuredContent as any).summary;
      expect(summary.users.distinct).toBe(30);
      expect(summary.users.top).toHaveLength(10);
    }
  });

  it('shorten explanations of pasted identifications with long values and many signals', async () => {
    connected = await connect({});
    const pasted = {
      request_id: 'r'.repeat(5_000),
      risk_score: 100,
      connection_type: 'x'.repeat(5_000),
      signals: Array.from({ length: 60 }, (_, index) => ({
        name: `${index}${'n'.repeat(2_000)}`,
        weight: 15,
      })),
    };
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.explainRiskScore, {
        identification: pasted,
        response_format: format,
      });
      expectWithinLimits(result, format);
      const explanation = result.structuredContent as any;
      expect(explanation.truncated).toBe(true);
      expect(explanation.truncation_message).toContain('names were cut to 100 characters');
      expect(explanation.truncation_message).toContain('request_id was cut to 100 characters');
      expect(explanation.truncation_message).toContain('connection_type was cut to 100 characters');
      expect(explanation.request_id).toHaveLength(100);
      if (format === 'markdown') expect(textOf(result)).toContain('Note: ');
    }
  });

  it('drop risk signals from an explanation until it fits, and say so', async () => {
    connected = await connect({});
    const many = {
      risk_score: 100,
      signals: Array.from({ length: 60 }, () => ({ name: 'antidetect_browser', weight: 60 })),
      detection_flags: Object.fromEntries(
        Object.keys(fixture('webhook-identification-scored.json').data.detection_flags).map(
          (flag) => [flag, true],
        ),
      ),
    };
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.explainRiskScore, {
        identification: many,
        response_format: format,
      });
      expectWithinLimits(result, format);
      const explanation = result.structuredContent as any;
      expect(explanation.detection_flags).toHaveLength(19);
      expect(explanation.signals.length).toBeGreaterThan(10);
      expect(explanation.signals.length).toBeLessThan(60);
      expect(explanation.truncation_message).toMatch(
        /Only the first \d+ of 60 risk signals are explained to keep the response under 25,000 characters\./,
      );
    }
  });

  it('shorten the event summary of an authentic body with oversized fields', async () => {
    connected = await connect({});
    const body = JSON.stringify({
      event_type: 'e'.repeat(50_000),
      schema_version: 'v'.repeat(50_000),
      created_at: 't'.repeat(50_000),
    });
    const signature = `sha256=${createHmac('sha256', 'whsec_test').update(body).digest('hex')}`;
    for (const format of ['markdown', 'json'] as const) {
      const result = await callTool(connected.client, TOOL_NAMES.verifyWebhookSignature, {
        payload: body,
        signature_header: signature,
        secret: 'whsec_test',
        response_format: format,
      });
      expectWithinLimits(result, format);
      const event = (result.structuredContent as any).event;
      expect(event.event_type).toBe(`${'e'.repeat(200)}... (50000 characters)`);
    }
  });
});

describe('last-resort limits', () => {
  it('replace oversized JSON with a small valid document that says what to ask for', () => {
    const json = enforceJsonLimit(
      JSON.stringify({ value: 'x'.repeat(30_000) }),
      'Use a smaller limit.',
    );
    expect(JSON.parse(json)).toEqual({
      truncated: true,
      truncation_message:
        'The JSON response has 30,012 characters, more than the limit of 25,000, so it was not returned. Use a smaller limit.',
    });
    expect(enforceJsonLimit('{"a":1}')).toBe('{"a":1}');
  });

  it('name the tool-specific hint when markdown is cut', () => {
    const cut = enforceCharacterLimit('y'.repeat(CHARACTER_LIMIT + 10), 'Use a smaller max_items.');
    expect(cut.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(
      cut.endsWith('[Response truncated at 25,000 characters. Use a smaller max_items.]'),
    ).toBe(true);
  });

  it('keep json text parseable in respond()', () => {
    const structured = { value: 'x'.repeat(30_000) };
    const result = respond({ secrets: [] }, structured, 'short', 'json', 'Use a smaller limit.');
    const parsed = JSON.parse(textOf(result));
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncation_message).toContain('Use a smaller limit.');
    expect(textOf(respond({ secrets: [] }, structured, 'short', 'markdown'))).toBe('short');
  });
});
