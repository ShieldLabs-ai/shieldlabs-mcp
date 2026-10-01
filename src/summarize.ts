import { NIL_UUID, type RiskBand } from '@shieldlabs-ai/node';
import { z } from 'zod';
import { bandOf, worseBand } from './catalog/bands.js';
import { DETECTION_FLAG_KEYS } from './catalog/detection-flags.js';
import { NON_ACCOUNT_USER_HIDS } from './constants.js';
import { cutSerialized, round1 } from './format.js';
import type { IdentificationOutput } from './identification.js';
import { nullableNumber, nullableString } from './schema.js';

/** How many values per dimension the summary lists with their counts. */
export const TOP_VALUES = 10;

/** Listed values are cut to this many characters (as serialized in JSON), so a summary stays small. */
export const MAX_SUMMARY_VALUE_LENGTH = 160;

/** How many risk signal names the summary lists at most, most frequent first. */
export const MAX_SIGNALS_SEEN = 50;

const ValueCountSchema = z.object({
  value: z.string(),
  count: z.number().int(),
  truncated: z
    .boolean()
    .optional()
    .describe(
      `Only present (true) when the value was cut to ${MAX_SUMMARY_VALUE_LENGTH} characters: a prefix of the stored value, not to be searched by`,
    ),
});

const DimensionSchema = z.object({
  distinct: z.number().int().describe('Number of distinct values in the window'),
  top: z
    .array(ValueCountSchema)
    .describe(`Up to ${TOP_VALUES} most frequent values with their counts`),
});

export const SummarySchema = z.object({
  identifications_analyzed: z.number().int(),
  first_observed_at: nullableString('Earliest observed_at in the window, RFC 3339 UTC'),
  last_observed_at: nullableString('Latest observed_at in the window, RFC 3339 UTC'),
  devices: DimensionSchema.describe('Device IDs, without the all-zero device ID'),
  users: DimensionSchema.describe(
    'User HIDs that name an account: without null, "anonymous", "fail", "-1" and "unknown"',
  ),
  visitors: DimensionSchema.describe('Visitor IDs, without the all-zero UUID'),
  countries: DimensionSchema.describe('Countries of the public IP (English names)'),
  ips: DimensionSchema.describe('Public IP addresses'),
  connection_types: DimensionSchema,
  anonymous_identifications: z
    .number()
    .int()
    .describe('Identifications whose User HID is "anonymous" (anonymous checks)'),
  identifications_without_account: z
    .number()
    .int()
    .describe('Identifications whose User HID is null, "anonymous", "fail", "-1" or "unknown"'),
  identifications_without_device_signals: z
    .number()
    .int()
    .describe('Identifications with the all-zero device ID'),
  risk: z.object({
    max_risk_score: z
      .number()
      .int()
      .nullable()
      .describe('Highest Risk Score, ignoring rate-limit markers'),
    average_risk_score: nullableNumber('Average Risk Score, ignoring rate-limit markers'),
    worst_band: z.enum(['trusted', 'suspicious', 'dangerous']).nullable(),
    band_counts: z.object({
      trusted: z.number().int(),
      suspicious: z.number().int(),
      dangerous: z.number().int(),
    }),
    rate_limit_markers: z
      .number()
      .int()
      .describe('Identifications carrying the 999 rate-limit marker'),
  }),
  flags_seen: z
    .array(z.object({ flag: z.string(), count: z.number().int() }))
    .describe(
      'Detection flags set on at least one identification, with how many identifications had each',
    ),
  signals_seen: z
    .array(z.object({ name: z.string(), count: z.number().int() }))
    .describe(
      `Risk signal names seen, with how many identifications carried each: at most ${MAX_SIGNALS_SEEN}, most frequent first`,
    ),
  distinct_signals: z
    .number()
    .int()
    .describe(
      'Number of distinct risk signal names seen, including any not listed in signals_seen',
    ),
});

export type Summary = z.infer<typeof SummarySchema>;

type ValueCount = z.infer<typeof ValueCountSchema>;

class Counter {
  readonly #counts = new Map<string, number>();

  add(value: string): void {
    this.#counts.set(value, (this.#counts.get(value) ?? 0) + 1);
  }

  dimension(): { distinct: number; top: ValueCount[] } {
    const top = [...this.#counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, TOP_VALUES)
      .map(([value, count]) => {
        const shown = cutSerialized(value, MAX_SUMMARY_VALUE_LENGTH);
        return shown === value ? { value, count } : { value: shown, count, truncated: true };
      });
    return { distinct: this.#counts.size, top };
  }

  entries(): [string, number][] {
    return [...this.#counts.entries()];
  }
}

function byCountThenName<T extends { count: number }>(key: (item: T) => string) {
  return (a: T, b: T): number =>
    b.count - a.count || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** Aggregates a window of identifications. Pure: the same input always gives the same summary. */
export function summarize(items: readonly IdentificationOutput[]): Summary {
  const devices = new Counter();
  const users = new Counter();
  const visitors = new Counter();
  const countries = new Counter();
  const ips = new Counter();
  const connectionTypes = new Counter();
  const flags = new Counter();
  const signals = new Counter();
  const bandCounts = { trusted: 0, suspicious: 0, dangerous: 0 };

  let anonymous = 0;
  let withoutAccount = 0;
  let withoutDeviceSignals = 0;
  let rateLimitMarkers = 0;
  let scoreSum = 0;
  let scored = 0;
  let maxScore: number | null = null;
  let worst: RiskBand | null = null;
  let first: number | null = null;
  let last: number | null = null;

  for (const item of items) {
    if (item.device_id === NIL_UUID) withoutDeviceSignals++;
    else if (item.device_id !== '') devices.add(item.device_id);

    if (item.user_hid === 'anonymous') anonymous++;
    if (item.user_hid === null || NON_ACCOUNT_USER_HIDS.has(item.user_hid)) withoutAccount++;
    else users.add(item.user_hid);

    if (item.visitor_id !== NIL_UUID && item.visitor_id !== '') visitors.add(item.visitor_id);
    if (item.public_ip.country !== '') countries.add(item.public_ip.country);
    if (item.public_ip.ip !== '') ips.add(item.public_ip.ip);
    if (item.connection_type !== '') connectionTypes.add(item.connection_type);

    for (const flag of DETECTION_FLAG_KEYS) {
      if (item.detection_flags[flag]) flags.add(flag);
    }
    for (const name of new Set(item.signals.map((signal) => signal.name))) signals.add(name);

    const band = bandOf(item.risk_score);
    if (band === 'rate_limited') {
      rateLimitMarkers++;
    } else {
      bandCounts[band]++;
      worst = worseBand(worst, band);
      scoreSum += item.risk_score;
      scored++;
      maxScore = maxScore === null ? item.risk_score : Math.max(maxScore, item.risk_score);
    }

    if (item.observed_at !== null) {
      const time = Date.parse(item.observed_at);
      if (!Number.isNaN(time)) {
        first = first === null ? time : Math.min(first, time);
        last = last === null ? time : Math.max(last, time);
      }
    }
  }

  return {
    identifications_analyzed: items.length,
    first_observed_at: first === null ? null : new Date(first).toISOString(),
    last_observed_at: last === null ? null : new Date(last).toISOString(),
    devices: devices.dimension(),
    users: users.dimension(),
    visitors: visitors.dimension(),
    countries: countries.dimension(),
    ips: ips.dimension(),
    connection_types: connectionTypes.dimension(),
    anonymous_identifications: anonymous,
    identifications_without_account: withoutAccount,
    identifications_without_device_signals: withoutDeviceSignals,
    risk: {
      max_risk_score: maxScore,
      average_risk_score: scored === 0 ? null : round1(scoreSum / scored),
      worst_band: worst,
      band_counts: bandCounts,
      rate_limit_markers: rateLimitMarkers,
    },
    flags_seen: flags
      .entries()
      .map(([flag, count]) => ({ flag, count }))
      .sort(byCountThenName((item) => item.flag)),
    signals_seen: signals
      .entries()
      .map(([name, count]) => ({ name, count }))
      .sort(byCountThenName((item) => item.name))
      .slice(0, MAX_SIGNALS_SEEN),
    distinct_signals: signals.entries().length,
  };
}
