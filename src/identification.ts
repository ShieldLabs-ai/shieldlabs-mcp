import { NIL_UUID, type Identification } from '@shieldlabs/node';
import { z } from 'zod';
import { bandOf } from './catalog/bands.js';
import { DETECTION_FLAG_KEYS } from './catalog/detection-flags.js';
import {
  code,
  cutSerialized,
  escapeInvisible,
  formatTimestamp,
  MAX_SIGNAL_NAME_LENGTH,
  MAX_VALUE_LENGTH,
  signedWeight,
} from './format.js';
import { nullableString } from './schema.js';

const IpInfoSchema = z.object({
  ip: z.string().describe('Dotted IPv4 address, or "" when none is known'),
  country: z.string().describe('English country name (for example "Germany"), or "" when unknown'),
});

const flagShape = Object.fromEntries(
  DETECTION_FLAG_KEYS.map((flag) => [flag, z.boolean()]),
) as Record<(typeof DETECTION_FLAG_KEYS)[number], z.ZodBoolean>;

export const RiskBandSchema = z.enum(['trusted', 'suspicious', 'dangerous', 'rate_limited']);

/** More risk signals than this on one identification only come from a malformed payload. */
export const MAX_SIGNALS_PER_IDENTIFICATION = 50;

/**
 * Identification as returned by this server's tools: the normalized model without `raw`, with
 * `risk_band` added and `signals[].description` always null.
 */
export const IdentificationOutputSchema = z.object({
  request_id: z.string(),
  visitor_id: z.string(),
  device_id: z.string(),
  session_id: z.string(),
  cookie_id: z.string(),
  user_hid: nullableString(
    'User HID as sent by the browser: "anonymous" for anonymous checks, null when it was empty',
  ),
  domain: z.string(),
  public_ip: IpInfoSchema,
  local_ip: IpInfoSchema,
  connection_type: z.string(),
  os: z.string(),
  browser: z.string(),
  device_type: z.string(),
  traffic_source: z.object({
    channel: z.string(),
    referrer_domain: z.string(),
    landing_url: z.string(),
    click_id_type: z.string(),
    utm_source: z.string(),
    utm_medium: z.string(),
    utm_campaign: z.string(),
    utm_content: z.string(),
    utm_term: z.string(),
  }),
  risk_score: z.number().int(),
  risk_band: RiskBandSchema,
  signals: z.array(
    z.object({
      name: z.string(),
      weight: z.number().int(),
      description: nullableString('Always null: internal score-detail text is not returned'),
    }),
  ),
  detection_flags: z.object(flagShape),
  observed_at: nullableString(
    'When the identification was observed, RFC 3339 UTC with milliseconds',
  ),
  source: z.enum(['webhook', 'history']),
  truncated_fields: z
    .array(z.string())
    .optional()
    .describe(
      `Only present when this server shortened values: paths of the fields cut to ${MAX_VALUE_LENGTH} characters as serialized in JSON (${MAX_SIGNAL_NAME_LENGTH} for risk signal names), and "signals" when only the first ${MAX_SIGNALS_PER_IDENTIFICATION} risk signals are listed. A shortened value is a prefix of the stored one: do not search by it.`,
    ),
  escaped_fields: z
    .array(z.string())
    .optional()
    .describe(
      'Only present when a value contained invisible or control characters: paths of the fields where this server replaced them with visible \\uXXXX or \\u{XXXXX} escapes. Such a value differs from the stored one: do not search by it.',
    ),
});

export type IdentificationOutput = z.infer<typeof IdentificationOutputSchema>;

/** Where a value was changed for output: escaped characters, a cut, or both. */
interface Changes {
  truncated: string[];
  escaped: string[];
}

/**
 * A string value made safe to show: invisible and control characters become visible escapes, and
 * the result is cut to `max` characters as serialized in JSON. Changes are recorded under `path`.
 */
function boundValue(value: string, path: string, max: number, changes: Changes): string {
  const escaped = escapeInvisible(value);
  if (escaped !== value) changes.escaped.push(path);
  const cut = cutSerialized(escaped, max);
  if (cut !== escaped) changes.truncated.push(path);
  return cut;
}

/** Copies `obj`, bounding every string value (see boundValue) and recording the changed paths. */
function boundStrings<T extends object>(obj: T, prefix: string, max: number, changes: Changes): T {
  const copy = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(copy)) {
    if (typeof value === 'string') copy[key] = boundValue(value, `${prefix}${key}`, max, changes);
  }
  return copy as T;
}

/**
 * The tool view of an identification: every normalized field except `raw`, plus the band. Values
 * reported by browsers (User HID, landing URL, UTM values) can hold any text of any length, so
 * invisible and control characters are escaped (listed in `escaped_fields`) and long values are
 * cut (listed in `truncated_fields`): one identification always fits in a response and cannot
 * hide text from the person reading it.
 */
export function toIdentificationOutput(identification: Identification): IdentificationOutput {
  const { raw: _raw, ...rest } = identification;
  const changes: Changes = { truncated: [], escaped: [] };
  // History rows and webhooks always carry an integer; anything else would come from a malformed payload.
  const score = Number.isFinite(rest.risk_score) ? Math.trunc(rest.risk_score) : 0;
  const signals = rest.signals.slice(0, MAX_SIGNALS_PER_IDENTIFICATION);
  const output: IdentificationOutput = {
    ...boundStrings(rest, '', MAX_VALUE_LENGTH, changes),
    public_ip: boundStrings(rest.public_ip, 'public_ip.', MAX_VALUE_LENGTH, changes),
    local_ip: boundStrings(rest.local_ip, 'local_ip.', MAX_VALUE_LENGTH, changes),
    traffic_source: boundStrings(rest.traffic_source, 'traffic_source.', MAX_VALUE_LENGTH, changes),
    risk_score: score,
    risk_band: bandOf(score),
    // History rows carry internal score-detail text in `description`; it is not meant to be
    // shown to users, so this server returns the slug and weight only (as webhooks do).
    signals: signals.map((signal, index) => ({
      name: boundValue(signal.name, `signals[${index}].name`, MAX_SIGNAL_NAME_LENGTH, changes),
      weight: Math.trunc(signal.weight),
      description: null,
    })),
  };
  if (signals.length < rest.signals.length) changes.truncated.push('signals');
  if (changes.truncated.length > 0) output.truncated_fields = changes.truncated;
  if (changes.escaped.length > 0) output.escaped_fields = changes.escaped;
  return output;
}

export function scoreLabel(score: number): string {
  if (score > 100) return `rate-limit marker ${score} (not a Risk Score)`;
  return `Risk Score ${score} (${bandOf(score)})`;
}

function userHidText(userHid: string | null): string {
  if (userHid === null) return 'none';
  if (userHid === 'anonymous') return `${code(userHid)} (anonymous check)`;
  return code(userHid);
}

function deviceIdText(deviceId: string): string {
  return deviceId === NIL_UUID ? `${code(deviceId)} (no usable device signals)` : code(deviceId);
}

function ipText(ip: { ip: string; country: string }): string {
  if (ip.ip === '') return 'none';
  return ip.country === '' ? code(ip.ip) : `${code(ip.ip)} (${code(ip.country)})`;
}

/** Markdown lines for one identification. Every API value is rendered as inert code. */
export function identificationMarkdown(item: IdentificationOutput, heading: string): string[] {
  const lines = [
    `${heading} ${scoreLabel(item.risk_score)}, observed ${formatTimestamp(item.observed_at)}`,
  ];
  lines.push(`- Request ID: ${code(item.request_id)}`);
  lines.push(`- User HID: ${userHidText(item.user_hid)}`);
  lines.push(
    `- Device ID: ${deviceIdText(item.device_id)}; visitor ID: ${code(item.visitor_id)}; cookie ID: ${code(item.cookie_id)}; session ID: ${code(item.session_id)}`,
  );
  lines.push(`- Domain: ${code(item.domain)}`);
  lines.push(`- Public IP: ${ipText(item.public_ip)}; local IP: ${ipText(item.local_ip)}`);
  lines.push(
    `- Connection type: ${code(item.connection_type)}; OS: ${code(item.os)}; browser: ${code(item.browser)}; device type: ${code(item.device_type)}`,
  );
  lines.push(
    `- Risk signals: ${
      item.signals.length === 0
        ? 'none'
        : item.signals.map((s) => `${code(s.name)} ${signedWeight(s.weight)}`).join(', ')
    }`,
  );
  const flags = DETECTION_FLAG_KEYS.filter((flag) => item.detection_flags[flag]);
  lines.push(
    `- Detection flags: ${flags.length === 0 ? 'none' : flags.map((f) => code(f)).join(', ')}`,
  );

  const source = item.traffic_source;
  const traffic: string[] = [];
  if (source.channel !== '') traffic.push(`channel ${code(source.channel)}`);
  if (source.referrer_domain !== '') traffic.push(`referrer ${code(source.referrer_domain)}`);
  if (source.landing_url !== '')
    traffic.push(`landing URL ${code(source.landing_url, { maxLength: 300 })}`);
  if (source.click_id_type !== '') traffic.push(`click ID type ${code(source.click_id_type)}`);
  const utm = (['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const)
    .filter((key) => source[key] !== '')
    .map((key) => `${key} ${code(source[key])}`);
  traffic.push(...utm);
  if (traffic.length > 0) lines.push(`- Traffic source: ${traffic.join('; ')}`);
  if (item.truncated_fields !== undefined) {
    lines.push(
      `- Shortened by this server (values longer than ${MAX_VALUE_LENGTH.toLocaleString('en-US')} characters, or more than ${MAX_SIGNALS_PER_IDENTIFICATION} risk signals): ${item.truncated_fields.join(', ')}`,
    );
  }
  if (item.escaped_fields !== undefined) {
    lines.push(
      `- Invisible or control characters shown as \\u escapes by this server: ${item.escaped_fields.join(', ')}`,
    );
  }
  return lines;
}
