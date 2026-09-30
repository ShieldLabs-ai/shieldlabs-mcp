#!/usr/bin/env node
// Generates the deterministic mock dataset in test/mock-data/: History API rows for one fictional
// domain (example.com), used by the evaluation questions in evaluation.xml and by the tests.
// Run: node scripts/generate-mock-data.mjs  (the output is committed; the tests check it is current)
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NIL = '00000000-0000-0000-0000-000000000000';
const DOMAIN = 'example.com';

const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A deterministic UUID of the given version from a seed. */
function uuid(seed, version) {
  const x = sha(`${version}:${seed}`);
  const variant = (8 + (parseInt(x[16], 16) & 3)).toString(16);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${version}${x.slice(13, 16)}-${variant}${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
const v4 = (seed) => uuid(seed, 4);
const v5 = (seed) => uuid(seed, 5);
/** A User HID as the server SDKs compute it: 64 lowercase hex characters. */
const hid = (account) => sha(`user-hid:${account}`);

/** Risk signals as History rows carry them: description, weight and the matching is_* column. */
const SIGNALS = {
  tor: ['Is tor', 99, 'is_tor'],
  vpn: ['Is VPN', 15, 'is_vpn'],
  relay: ['Is privacy relay', 15, 'is_privacy_relay'],
  proxy: ['Is proxy', 10, 'is_proxy'],
  datacenter: ['Is datacenter', 10, 'is_datacenter'],
  abuser: ['Is abuser', 10, 'is_abuser'],
  antidetect: ['Antidetect browser (turn_block)', 60, 'is_antidetect'],
  automation: ['Browser Automation', 60, 'is_browser_automation'],
  js_disabled: ['JavaScript disabled (WebRTC, WebGL)', 90, 'is_js_disabled'],
  os_mismatch: ['Os_mismatch (Fail by windows detect)', 60, 'is_os_mismatch'],
  os_not_detected: ['UA OS is not detected', 30, 'is_os_not_detected'],
  timezone: ['Browser timezone ≠ IP-timezone', 10, 'is_timezone_mismatch'],
  stun: ['Stun is not checked', 30, 'is_stun_not_checked'],
  bvp: ['Browser VPN/Proxy', 30, null],
  rate_limited: ['User has been banned 1H, to many requests', 999, null],
};

const FLAG_COLUMNS = [
  'is_vpn',
  'is_tor',
  'is_proxy',
  'is_datacenter',
  'is_abuser',
  'is_privacy_relay',
  'is_stun_not_checked',
  'check_incomplete',
  'is_antidetect',
  'is_os_mismatch',
  'is_os_not_detected',
  'is_timezone_mismatch',
  'is_js_disabled',
  'is_browser_automation',
  'is_incognito',
  'is_search_bot',
];

const PAID_CHANNELS = new Set([
  'Google Ads',
  'Meta',
  'TikTok',
  'LinkedIn',
  'X',
  'Pinterest',
  'Microsoft Ads',
]);

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** "2026-09-14 10:02:00.000" (History API format, UTC) and the epoch milliseconds. */
function timestamp(iso) {
  const date = new Date(iso);
  const text = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
  return { text, ms: date.getTime() };
}

export const MOCK_PROFILE = {
  Domain: DOMAIN,
  Weight: 148230,
  Callback: '',
  PublicKey: '****************************a3f8',
  Secret: '****************************9c2d',
  CreatedAt: '2026-01-15T09:00:00Z',
};

/** Builds the dataset: History rows newest first, as the History API returns them. */
export function buildRows() {
  const rows = [];

  function add(spec) {
    const {
      at,
      seed,
      user = 'anonymous',
      device,
      visitor,
      cookie,
      session,
      ip,
      country,
      os = 'Windows',
      browser = 'Chrome',
      deviceType = 'desktop',
      connection = 'direct',
      signals = [],
      local = undefined,
      incognito = false,
      searchBot = false,
      traffic = undefined,
      requestDomain = DOMAIN,
    } = spec;
    const time = timestamp(at);
    const flags = Object.fromEntries(FLAG_COLUMNS.map((column) => [column, false]));
    const details = signals.map((key) => {
      const [description, weight, column] = SIGNALS[key];
      if (column !== null) flags[column] = true;
      return { Value: weight, Description: description };
    });
    const rateLimited = signals.includes('rate_limited');
    const sum = details.reduce((total, detail) => total + detail.Value, 0);
    const score = searchBot ? 0 : rateLimited ? 999 : Math.min(100, sum);
    flags.is_incognito = incognito;
    flags.is_search_bot = searchBot;
    const localIp = local ?? (rateLimited ? { ip: '0.0.0.0', country: '' } : { ip, country });

    const row = {
      request_id: v4(`request:${seed}`),
      session_id: session ?? (rateLimited ? NIL : v4(`session:${seed}`)),
      cookie_id: cookie ?? (rateLimited ? NIL : v4(`cookie:${seed}`)),
      domain: requestDomain,
      ...(requestDomain !== DOMAIN ? { site_domain: DOMAIN } : {}),
      user_hid: user === 'anonymous' || user === '-1' ? user : hid(user),
      device_id: device ?? NIL,
      visitor_id: visitor ?? NIL,
      ip,
      os,
      browser,
      device_type: deviceType,
      country,
      connection_type: connection,
      score,
      score_details: details.length === 0 ? '' : JSON.stringify(details),
      created_at: time.text,
      ver: time.ms,
      web_rtc_ip: localIp.ip,
      web_rtc_country: localIp.country,
      web_rtc_connection_type: localIp.ip === '0.0.0.0' ? '' : 'direct',
      scanner_web_rtc_ip: '0.0.0.0',
      scanner_web_rtc_country: '',
      scanner_web_rtc_connection_type: '',
      webrtc_leak_ip: '0.0.0.0',
      webrtc_leak_country: '',
      webrtc_leak_connection_type: '',
      webrtc_leak_source: rateLimited ? '' : 'none',
      tcp_mss: rateLimited ? 0 : 1460,
      mtu_value: rateLimited ? 0 : 1500,
      mtu_hint: rateLimited ? '' : 'direct',
      ...flags,
      stun_request_seen: !rateLimited,
      is_scanner_stun_passed: false,
      stun_flow_status: rateLimited ? '' : 'ok',
    };
    if (traffic !== undefined) {
      const { channel, group, reason, referrer, url, click, source, medium, campaign } = traffic;
      if (url) row.entry_url = url;
      if (source) row.utm_source = source;
      if (medium) row.utm_medium = medium;
      if (campaign) row.utm_campaign = campaign;
      if (channel) row.traffic_channel = channel;
      if (group) row.traffic_channel_group = group;
      if (reason) row.traffic_reason = reason;
      if (referrer) row.referrer_domain = referrer;
      if (click) row.click_id_type = click;
      if (channel && PAID_CHANNELS.has(channel) && score >= 60) row.is_suspicious_paid_click = true;
    }
    rows.push(row);
    return row;
  }

  const minutes = (iso, n) => new Date(new Date(iso).getTime() + n * 60_000).toISOString();

  // 1. A long-standing account: 130 identifications on a laptop and a phone, 17 of them over a VPN.
  const alice = { device: v5('device:alice-laptop'), visitor: v5('visitor:alice-laptop') };
  const alicePhone = { device: v5('device:alice-phone'), visitor: v5('visitor:alice-phone') };
  for (let i = 0; i < 130; i++) {
    const onPhone = i % 5 === 4;
    const viaVpn = i % 8 === 3 || i === 128;
    add({
      at: minutes('2026-09-01T07:00:00.000Z', i * 300 + (i % 3) * 7),
      seed: `alice-${i}`,
      user: 'acct-1001',
      ...(onPhone ? alicePhone : alice),
      cookie: v4(onPhone ? 'cookie:alice-phone' : 'cookie:alice-laptop'),
      ip: viaVpn ? '203.0.113.50' : onPhone ? '198.51.100.11' : '198.51.100.10',
      country: viaVpn ? 'Netherlands' : 'Germany',
      os: onPhone ? 'IOS (iPhone)' : 'Mac OS X',
      browser: onPhone ? 'Safari (iOS)' : 'Safari',
      deviceType: onPhone ? 'mobile' : 'desktop',
      connection: viaVpn ? 'vpn' : onPhone ? 'mobile' : 'direct',
      signals: viaVpn ? ['vpn'] : [],
      ...(viaVpn ? { local: { ip: '198.51.100.10', country: 'Germany' } } : {}),
    });
  }

  // 2. One device creating several accounts behind proxies (4 accounts plus anonymous checks).
  const farmDevice = v5('device:farm');
  const farmVisitors = [v5('visitor:farm-1'), v5('visitor:farm-2')];
  const farm = [
    ['2026-09-14T09:55:00.000Z', 'anonymous', '203.0.113.101', 'Netherlands', ['proxy'], 0],
    [
      '2026-09-14T10:02:00.000Z',
      'acct-2001',
      '203.0.113.101',
      'Netherlands',
      ['proxy', 'datacenter'],
      0,
    ],
    [
      '2026-09-14T10:40:00.000Z',
      'acct-2001',
      '203.0.113.101',
      'Netherlands',
      ['proxy', 'datacenter', 'antidetect'],
      0,
    ],
    [
      '2026-09-14T11:15:00.000Z',
      'acct-2002',
      '203.0.113.102',
      'Germany',
      ['proxy', 'datacenter'],
      0,
    ],
    [
      '2026-09-15T09:00:00.000Z',
      'acct-2002',
      '203.0.113.102',
      'Germany',
      ['proxy', 'datacenter'],
      0,
    ],
    [
      '2026-09-15T13:20:00.000Z',
      'anonymous',
      '203.0.113.103',
      'Poland',
      ['proxy', 'datacenter'],
      1,
    ],
    [
      '2026-09-15T13:30:00.000Z',
      'acct-2003',
      '203.0.113.103',
      'Poland',
      ['proxy', 'datacenter', 'abuser', 'antidetect'],
      1,
    ],
    [
      '2026-09-15T14:05:00.000Z',
      'acct-2003',
      '203.0.113.103',
      'Poland',
      ['proxy', 'datacenter'],
      1,
    ],
    ['2026-09-16T08:10:00.000Z', 'anonymous', '203.0.113.104', 'Romania', ['proxy'], 1],
    ['2026-09-16T08:20:00.000Z', 'acct-2004', '203.0.113.104', 'Romania', ['proxy'], 1],
    [
      '2026-09-16T08:55:00.000Z',
      'acct-2004',
      '203.0.113.104',
      'Romania',
      ['proxy', 'antidetect'],
      1,
    ],
    [
      '2026-09-16T09:30:00.000Z',
      'acct-2004',
      '203.0.113.104',
      'Romania',
      ['proxy', 'datacenter'],
      1,
    ],
  ];
  farm.forEach(([at, user, ip, country, signals, visitor], index) => {
    add({
      at,
      seed: `farm-${index}`,
      user,
      device: farmDevice,
      visitor: farmVisitors[visitor],
      ip,
      country,
      connection: 'proxy',
      signals,
      local: { ip: '192.0.2.200', country: 'Ukraine' },
    });
  });

  // 3. One account used on five devices (France, Germany, Spain).
  const bobDevices = {
    win: {
      device: v5('device:bob-win'),
      visitor: v5('visitor:bob-win'),
      os: 'Windows',
      browser: 'Chrome',
      deviceType: 'desktop',
      ip: '192.0.2.30',
      country: 'France',
      connection: 'direct',
    },
    mac: {
      device: v5('device:bob-mac'),
      visitor: v5('visitor:bob-mac'),
      os: 'Mac OS X',
      browser: 'Safari',
      deviceType: 'desktop',
      ip: '192.0.2.30',
      country: 'France',
      connection: 'direct',
    },
    iphone: {
      device: v5('device:bob-iphone'),
      visitor: v5('visitor:bob-iphone'),
      os: 'IOS (iPhone)',
      browser: 'Safari (iOS)',
      deviceType: 'mobile',
      ip: '198.51.100.60',
      country: 'Germany',
      connection: 'mobile',
    },
    android: {
      device: v5('device:bob-android'),
      visitor: v5('visitor:bob-android'),
      os: 'Android',
      browser: 'Chrome',
      deviceType: 'mobile',
      ip: '198.51.100.61',
      country: 'Germany',
      connection: 'mobile',
    },
    ipad: {
      device: v5('device:bob-ipad'),
      visitor: v5('visitor:bob-ipad'),
      os: 'IOS (iPad)',
      browser: 'Safari (iOS)',
      deviceType: 'tablet',
      ip: '203.0.113.30',
      country: 'Spain',
      connection: 'direct',
    },
  };
  const bob = [
    ['2026-09-03T07:45:30.250Z', 'win'],
    ['2026-09-04T18:10:00.000Z', 'win'],
    ['2026-09-06T12:00:00.000Z', 'iphone'],
    ['2026-09-08T09:30:00.000Z', 'mac'],
    ['2026-09-10T21:15:00.000Z', 'android'],
    ['2026-09-12T08:05:00.000Z', 'win'],
    ['2026-09-14T13:40:00.000Z', 'ipad'],
    ['2026-09-16T19:00:00.000Z', 'iphone'],
    ['2026-09-18T10:20:00.000Z', 'mac'],
    ['2026-09-20T16:45:00.000Z', 'android'],
    ['2026-09-23T11:00:00.000Z', 'win'],
    ['2026-09-25T20:30:00.000Z', 'ipad'],
  ];
  bob.forEach(([at, key], index) => {
    const { ip, country, ...device } = bobDevices[key];
    add({
      at,
      seed: `bob-${index}`,
      user: 'acct-3001',
      ...device,
      ip,
      country,
      signals: key === 'ipad' ? ['timezone'] : [],
    });
  });

  // 4. An account seen in Germany and, 27 minutes later, in Brazil.
  const carolHome = {
    device: v5('device:carol-laptop'),
    visitor: v5('visitor:carol-laptop'),
    os: 'Windows',
    browser: 'Microsoft Edge',
  };
  const carolOther = {
    device: v5('device:carol-other'),
    visitor: v5('visitor:carol-other'),
    os: 'Windows',
    browser: 'Chrome',
  };
  const carol = [
    ['2026-09-05T08:00:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    ['2026-09-08T19:30:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    ['2026-09-12T07:15:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    ['2026-09-15T12:00:00.000Z', 'Austria', '192.0.2.90', carolHome, 'direct', []],
    ['2026-09-15T18:45:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    ['2026-09-20T09:10:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    [
      '2026-09-20T09:37:00.000Z',
      'Brazil',
      '203.0.113.77',
      carolOther,
      'proxy',
      ['proxy', 'timezone'],
    ],
    [
      '2026-09-20T10:05:00.000Z',
      'Brazil',
      '203.0.113.77',
      carolOther,
      'proxy',
      ['proxy', 'timezone'],
    ],
    ['2026-09-20T14:30:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
    ['2026-09-26T21:00:00.000Z', 'Germany', '198.51.100.40', carolHome, 'direct', []],
  ];
  carol.forEach(([at, country, ip, device, connection, signals], index) => {
    add({
      at,
      seed: `carol-${index}`,
      user: 'acct-4001',
      ...device,
      ip,
      country,
      connection,
      signals,
    });
  });

  // 5. An automated burst from one IP address: two automated identifications, then three rate-limit markers.
  const automatedDevice = {
    device: v5('device:bot'),
    visitor: v5('visitor:bot'),
    os: 'Linux',
    browser: 'Chrome',
  };
  add({
    at: '2026-09-18T21:58:00.000Z',
    seed: 'burst-0',
    ...automatedDevice,
    ip: '203.0.113.200',
    country: 'Singapore',
    connection: 'proxy',
    signals: ['automation', 'datacenter'],
  });
  add({
    at: '2026-09-18T21:59:10.000Z',
    seed: 'burst-1',
    ...automatedDevice,
    ip: '203.0.113.200',
    country: 'Singapore',
    connection: 'proxy',
    signals: ['automation', 'datacenter'],
  });
  for (const [index, at] of [
    '2026-09-18T22:01:00.500Z',
    '2026-09-18T22:15:00.000Z',
    '2026-09-18T22:40:00.000Z',
  ].entries()) {
    add({
      at,
      seed: `ban-${index}`,
      user: '-1',
      ip: '203.0.113.200',
      country: '',
      os: 'Unknown',
      browser: 'Unknown',
      connection: 'unknown',
      signals: ['rate_limited'],
    });
  }

  // 6. A device whose reported operating system does not add up.
  const emu = {
    device: v5('device:emu'),
    visitor: v5('visitor:emu'),
    os: 'Android',
    browser: 'Chrome',
    deviceType: 'mobile',
  };
  add({
    at: '2026-09-10T14:00:00.000Z',
    seed: 'emu-0',
    user: 'acct-5001',
    ...emu,
    ip: '198.51.100.120',
    country: 'Italy',
    signals: ['os_mismatch', 'timezone'],
  });
  add({
    at: '2026-09-10T14:20:00.000Z',
    seed: 'emu-1',
    user: 'acct-5001',
    ...emu,
    ip: '198.51.100.120',
    country: 'Italy',
    signals: ['os_mismatch'],
  });
  add({
    at: '2026-09-11T09:00:00.000Z',
    seed: 'emu-2',
    user: 'acct-5001',
    ...emu,
    ip: '198.51.100.121',
    country: 'Italy',
    signals: ['timezone'],
  });
  add({
    at: '2026-09-12T16:45:00.000Z',
    seed: 'emu-3',
    user: 'acct-5001',
    ...emu,
    ip: '203.0.113.121',
    country: 'Italy',
    connection: 'proxy',
    signals: ['proxy', 'datacenter', 'abuser'],
  });

  // 7. A visitor arriving from ad campaigns, twice flagged as a suspicious paid click.
  const ads = {
    device: v5('device:ads'),
    visitor: v5('visitor:ads'),
    os: 'Windows',
    browser: 'Chrome',
  };
  const google = (campaign, gclid) => ({
    channel: 'Google Ads',
    group: 'Paid Search',
    reason: 'gclid_present',
    click: 'gclid',
    source: 'google',
    medium: 'cpc',
    campaign,
    url: `https://example.com/pricing?utm_source=google&utm_medium=cpc&utm_campaign=${campaign}&gclid=${gclid}`,
  });
  add({
    at: '2026-09-21T10:00:00.000Z',
    seed: 'ads-0',
    ...ads,
    ip: '198.51.100.140',
    country: 'United States',
    traffic: google('brand_search', 'g1'),
  });
  add({
    at: '2026-09-22T15:30:00.000Z',
    seed: 'ads-1',
    ...ads,
    ip: '203.0.113.141',
    country: 'United States',
    connection: 'proxy',
    signals: ['antidetect', 'proxy'],
    traffic: google('autumn_sale_2026', 'g2'),
  });
  add({
    at: '2026-09-23T11:10:00.000Z',
    seed: 'ads-2',
    ...ads,
    ip: '203.0.113.141',
    country: 'United States',
    connection: 'proxy',
    signals: ['proxy'],
    traffic: {
      channel: 'Meta',
      group: 'Paid Social',
      reason: 'fbclid_present',
      click: 'fbclid',
      referrer: 'facebook.com',
      source: 'facebook',
      medium: 'paid_social',
      campaign: 'lookalike_test',
      url: 'https://example.com/?utm_source=facebook&utm_medium=paid_social&utm_campaign=lookalike_test&fbclid=f1',
    },
  });
  add({
    at: '2026-09-24T18:20:00.000Z',
    seed: 'ads-3',
    ...ads,
    ip: '203.0.113.142',
    country: 'United States',
    connection: 'proxy',
    signals: ['antidetect'],
    traffic: google('retargeting_q4', 'g3'),
  });
  add({
    at: '2026-09-25T09:05:00.000Z',
    seed: 'ads-4',
    ...ads,
    ip: '198.51.100.140',
    country: 'United States',
    traffic: {
      channel: 'Direct',
      group: 'Direct',
      reason: 'no_source_detected',
      url: 'https://example.com/signup',
    },
  });

  // 8. Background traffic: crawlers, Tor, headless clients, relays and ordinary anonymous visitors.
  const crawler = {
    referrer: 'GoogleBot',
    channel: 'Search bot',
    group: 'Bot',
    reason: 'ip_crawler_detected',
  };
  add({
    at: '2026-09-09T03:00:00.000Z',
    seed: 'crawler-0',
    device: v5('device:crawler'),
    visitor: v5('visitor:crawler'),
    os: 'Linux',
    ip: '198.51.100.66',
    country: 'United States',
    connection: 'proxy',
    searchBot: true,
    traffic: crawler,
  });
  add({
    at: '2026-09-19T03:00:00.000Z',
    seed: 'crawler-1',
    device: v5('device:crawler'),
    visitor: v5('visitor:crawler'),
    os: 'Linux',
    ip: '198.51.100.66',
    country: 'United States',
    connection: 'proxy',
    searchBot: true,
    traffic: crawler,
  });
  add({
    at: '2026-09-17T23:10:00.000Z',
    seed: 'tor-0',
    device: v5('device:tor'),
    visitor: v5('visitor:tor'),
    os: 'Windows',
    browser: 'Firefox',
    ip: '192.0.2.250',
    country: 'Germany',
    connection: 'tor',
    signals: ['tor'],
  });
  add({
    at: '2026-09-17T23:20:00.000Z',
    seed: 'headless-0',
    device: v5('device:headless'),
    visitor: v5('visitor:headless'),
    os: 'Linux',
    ip: '203.0.113.210',
    country: 'Singapore',
    signals: ['js_disabled'],
  });
  add({
    at: '2026-09-13T12:00:00.000Z',
    seed: 'relay-0',
    device: v5('device:relay'),
    visitor: v5('visitor:relay'),
    os: 'Mac OS X',
    browser: 'Safari',
    ip: '198.51.100.170',
    country: 'United States',
    connection: 'privacy_relay',
    signals: ['relay'],
    incognito: true,
  });
  add({
    at: '2026-09-13T12:30:00.000Z',
    seed: 'bvp-0',
    device: v5('device:bvp'),
    visitor: v5('visitor:bvp'),
    os: 'Windows',
    ip: '198.51.100.171',
    country: 'Canada',
    connection: 'browser_vpn_proxy',
    signals: ['bvp'],
  });
  for (let i = 0; i < 10; i++) {
    add({
      at: minutes('2026-09-02T10:00:00.000Z', i * 3571),
      seed: `visitor-${i}`,
      device: v5(`device:visitor-${i}`),
      visitor: v5(`visitor:visitor-${i}`),
      os: i % 2 === 0 ? 'Windows' : 'Android',
      deviceType: i % 2 === 0 ? 'desktop' : 'mobile',
      ip: `192.0.2.${10 + i}`,
      country: ['United States', 'Canada', 'United Kingdom', 'France', 'Japan'][i % 5],
      connection: i % 2 === 0 ? 'direct' : 'mobile',
      signals: i === 7 ? ['stun'] : [],
      requestDomain: i % 3 === 0 ? 'shop.example.com' : DOMAIN,
    });
  }

  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return rows;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const outDir = fileURLToPath(new URL('../test/mock-data/', import.meta.url));
  const rows = buildRows();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'history-rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(
    join(outDir, 'management-profile.json'),
    `${JSON.stringify(MOCK_PROFILE, null, 2)}\n`,
  );
  process.stdout.write(`Wrote ${rows.length} History rows to test/mock-data/\n`);
}
