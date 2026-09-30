import { afterEach, describe, expect, it } from 'vitest';
import { NIL_UUID } from '@shieldlabs/node';
import { TOOL_NAMES } from '../src/constants.js';
import { summarize } from '../src/summarize.js';
import { toIdentificationOutput } from '../src/identification.js';
import {
  callJson,
  callTool,
  connect,
  FULL_ENV,
  mockApiFetch,
  mockRows,
  statusFetch,
  textOf,
  type Connected,
} from './helpers.js';

let connected: Connected | undefined;

afterEach(async () => {
  await connected?.close();
  connected = undefined;
});

const rows = mockRows();
const farmDevice = rows.find(
  (row) => row.connection_type === 'proxy' && row.web_rtc_country === 'Ukraine',
)!.device_id as string;
const aliceHid = rows.find(
  (row) =>
    row.os === 'Mac OS X' &&
    row.connection_type === 'direct' &&
    row.browser === 'Safari' &&
    row.country === 'Germany',
)!.user_hid as string;

describe('shieldlabs_summarize_entity', () => {
  it('counts accounts on one device, without anonymous checks', async () => {
    connected = await connect();
    const output = await callJson(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'device_id',
      value: farmDevice.toUpperCase(),
    });
    expect(output.lookup).toEqual({ type: 'device_id', value: farmDevice });
    expect(output.computed_from).toContain('not a verdict from ShieldLabs');
    expect(output.window).toEqual({
      identifications_analyzed: 12,
      total_matching: 12,
      max_items: 100,
      complete: true,
    });
    const { summary } = output;
    expect(summary.users.distinct).toBe(4);
    expect(summary.anonymous_identifications).toBe(3);
    expect(summary.identifications_without_account).toBe(3);
    expect(summary.devices).toEqual({ distinct: 1, top: [{ value: farmDevice, count: 12 }] });
    expect(summary.visitors.distinct).toBe(2);
    expect(summary.countries.distinct).toBe(4);
    expect(summary.ips.distinct).toBe(4);
    expect(summary.connection_types).toEqual({ distinct: 1, top: [{ value: 'proxy', count: 12 }] });
    expect(summary.risk.worst_band).toBe('dangerous');
    expect(summary.risk.max_risk_score).toBe(90);
    expect(summary.risk.band_counts).toEqual({ trusted: 9, suspicious: 0, dangerous: 3 });
    expect(summary.risk.rate_limit_markers).toBe(0);
    expect(summary.first_observed_at).toBe('2026-09-14T09:55:00.000Z');
    expect(summary.last_observed_at).toBe('2026-09-16T09:30:00.000Z');
    expect(summary.flags_seen.slice(0, 2)).toEqual([
      { flag: 'ip_mismatch', count: 12 },
      { flag: 'proxy', count: 12 },
    ]);
    expect(summary.flags_seen).toContainEqual({ flag: 'anti_detect_browser', count: 3 });
    expect(summary.flags_seen).toContainEqual({ flag: 'ip_mismatch', count: 12 });
    expect(summary.signals_seen).toContainEqual({ name: 'antidetect_browser', count: 3 });
  });

  it('pages through more than 100 identifications in one call', async () => {
    const api = mockApiFetch();
    connected = await connect(FULL_ENV, { apiFetch: api.fetch });
    const output = await callJson(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'user_hid',
      value: aliceHid,
      max_items: 200,
    });
    expect(output.window).toMatchObject({
      identifications_analyzed: 130,
      total_matching: 130,
      complete: true,
    });
    expect(api.calls.map((call) => new URL(call.url).search)).toEqual([
      '?limit=100&offset=0',
      '?limit=100&offset=100',
    ]);
    expect(output.summary.connection_types.top).toContainEqual({ value: 'vpn', count: 17 });
    expect(output.summary.devices.distinct).toBe(2);
    expect(output.summary.countries.top[0]).toEqual({ value: 'Germany', count: 113 });
  });

  it('labels an incomplete window and respects max_items', async () => {
    const api = mockApiFetch();
    connected = await connect(FULL_ENV, { apiFetch: api.fetch });
    const result = await callTool(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'user_hid',
      value: aliceHid,
      max_items: 30,
    });
    const text = textOf(result);
    expect(text).toContain(
      'Computed by this MCP server from the identifications returned by the History API',
    );
    expect(text).toContain(
      'the 30 most recent of 130 matching identifications (incomplete: raise max_items above 30',
    );
    expect(text).toContain('## Risk');
    expect(text).toContain('## Detection flags seen');
    expect((result.structuredContent as any).window.complete).toBe(false);
    expect(api.calls).toHaveLength(1);
    expect(new URL(api.calls[0]!.url).search).toBe('?limit=30&offset=0');
  });

  it('counts rate-limit markers apart from the Risk Score statistics', async () => {
    connected = await connect();
    const output = await callJson(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'ip',
      value: '203.0.113.200',
    });
    const { summary } = output;
    expect(summary.risk.rate_limit_markers).toBe(3);
    expect(summary.risk.max_risk_score).toBe(70);
    expect(summary.risk.average_risk_score).toBe(70);
    expect(summary.identifications_without_device_signals).toBe(3);
    expect(summary.devices.distinct).toBe(1);
    expect(summary.identifications_without_account).toBe(5);
  });

  it('stops paging when the server keeps repeating the same rows', async () => {
    const repeated = rows.slice(0, 100);
    const api = statusFetch(200, JSON.stringify({ data: repeated, total: 1_000_000 }));
    connected = await connect(FULL_ENV, { apiFetch: api.fetch });
    const output = await callJson(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'ip',
      value: '198.51.100.10',
      max_items: 300,
    });
    expect(api.calls).toHaveLength(5);
    expect(output.window).toMatchObject({
      identifications_analyzed: 100,
      total_matching: 1_000_000,
      complete: false,
    });
  });

  it('reports an empty history without guessing', async () => {
    connected = await connect();
    const result = await callTool(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'cookie_id',
      value: '11111111-2222-4333-8444-555555555555',
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('nothing to summarize');
    expect((result.structuredContent as any).summary.risk.worst_band).toBeNull();
  });

  it('refuses types it does not aggregate', async () => {
    connected = await connect();
    const result = await callTool(connected.client, TOOL_NAMES.summarizeEntity, {
      type: 'request_id',
      value: '11111111-2222-4333-8444-555555555555',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Input validation error');
  });
});

describe('summarize()', () => {
  it('skips the all-zero IDs, sentinel User HIDs and unparsable timestamps', () => {
    const base = toIdentificationOutput({
      request_id: 'r1',
      visitor_id: NIL_UUID,
      device_id: NIL_UUID,
      session_id: NIL_UUID,
      cookie_id: NIL_UUID,
      user_hid: 'fail',
      domain: 'example.com',
      public_ip: { ip: '', country: '' },
      local_ip: { ip: '', country: '' },
      connection_type: '',
      os: 'Unknown',
      browser: 'Unknown',
      device_type: 'unknown',
      traffic_source: {
        channel: '',
        referrer_domain: '',
        landing_url: '',
        click_id_type: '',
        utm_source: '',
        utm_medium: '',
        utm_campaign: '',
        utm_content: '',
        utm_term: '',
      },
      risk_score: 40,
      signals: [
        { name: 'vpn', weight: 15, description: null },
        { name: 'vpn', weight: 15, description: null },
      ],
      detection_flags: Object.fromEntries(
        [
          'vpn',
          'privacy_relay',
          'browser_vpn_proxy',
          'tor',
          'proxy',
          'datacenter_ip',
          'abuser',
          'os_mismatch',
          'os_not_detected',
          'timezone_mismatch',
          'anti_detect_browser',
          'browser_automation',
          'ip_mismatch',
          'incognito',
          'search_bot',
          'suspicious_paid_click',
          'javascript_disabled',
          'stun_not_checked',
          'check_incomplete',
        ].map((flag) => [flag, false]),
      ) as any,
      observed_at: 'not a date',
      source: 'history',
      raw: {},
    });
    const summary = summarize([
      base,
      {
        ...base,
        request_id: 'r2',
        user_hid: null,
        observed_at: null,
        risk_score: 10,
        risk_band: 'trusted',
      },
    ]);
    expect(summary.devices.distinct).toBe(0);
    expect(summary.visitors.distinct).toBe(0);
    expect(summary.users.distinct).toBe(0);
    expect(summary.identifications_without_account).toBe(2);
    expect(summary.identifications_without_device_signals).toBe(2);
    expect(summary.first_observed_at).toBeNull();
    expect(summary.signals_seen).toEqual([{ name: 'vpn', count: 2 }]);
    expect(summary.risk).toMatchObject({
      worst_band: 'suspicious',
      max_risk_score: 40,
      average_risk_score: 25,
    });
    expect(summary.connection_types.distinct).toBe(0);
  });

  it('lists at most ten values per dimension, most frequent first', () => {
    const items = rows.slice(0, 60).map((row) =>
      toIdentificationOutput({
        ...(row as any),
        public_ip: { ip: row.ip, country: row.country },
        local_ip: { ip: '', country: '' },
        traffic_source: {
          channel: '',
          referrer_domain: '',
          landing_url: '',
          click_id_type: '',
          utm_source: '',
          utm_medium: '',
          utm_campaign: '',
          utm_content: '',
          utm_term: '',
        },
        risk_score: row.score,
        signals: [],
        detection_flags: {} as any,
        observed_at: null,
        source: 'history',
        raw: {},
      }),
    );
    const summary = summarize(items);
    expect(summary.ips.top.length).toBeLessThanOrEqual(10);
    const counts = summary.ips.top.map((entry) => entry.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});
