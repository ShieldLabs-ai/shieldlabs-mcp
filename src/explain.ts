import { NIL_UUID, ShieldLabs, type Identification } from '@shieldlabs-ai/node';
import { z } from 'zod';
import { bandInfo, bandOf, bandRange, RATE_LIMIT_MARKER_NOTE } from './catalog/bands.js';
import { connectionTypeInfo } from './catalog/connection-types.js';
import { DETECTION_FLAG_KEYS, detectionFlagInfo } from './catalog/detection-flags.js';
import { riskSignalInfo, UNKNOWN_SIGNAL_MEANING } from './catalog/risk-signals.js';
import { CHARACTER_LIMIT } from './constants.js';
import { ToolInputError } from './errors.js';
import {
  code,
  cutSerialized,
  escapeInvisible,
  MAX_SIGNAL_NAME_LENGTH,
  signedWeight,
} from './format.js';
import { RiskBandSchema } from './identification.js';
import { nullableString } from './schema.js';

/** At most this many signals are explained; longer lists only come from unusual input. */
const MAX_SIGNALS = 60;

/** A pasted request ID or connection type longer than this is cut (real values are short). */
const MAX_PASTED_VALUE_LENGTH = 100;

/** The rate-limit marker: the only valid value above 100. */
const RATE_LIMIT_MARKER = 999;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return 'a string';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/** Accepts the valid Risk Score values only: an integer from 0 to 100, or the 999 marker. */
function checkRiskScore(value: unknown, field: string): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    ((value >= 0 && value <= 100) || value === RATE_LIMIT_MARKER)
  ) {
    return value;
  }
  throw new ToolInputError(
    `${field} must be an integer from 0 to 100, or the ${RATE_LIMIT_MARKER} rate-limit marker; got ${describeValue(value)}.`,
  );
}

/** Weights are integers (negative for corrections); anything else is not an identification. */
function checkWeight(weight: number, where: string): number {
  if (!Number.isSafeInteger(weight)) {
    throw new ToolInputError(`${where} must be an integer; got ${describeValue(weight)}.`);
  }
  return weight;
}

/** The part of an identification that an explanation needs. */
export interface ExplainInput {
  request_id: string | null;
  device_id: string | null;
  risk_score: number;
  signals: { name: string; weight: number }[];
  flags: Partial<Record<(typeof DETECTION_FLAG_KEYS)[number], boolean>>;
  connection_type: string | null;
  source: 'history' | 'webhook' | 'input';
}

export function fromIdentification(identification: Identification): ExplainInput {
  return {
    request_id: identification.request_id,
    device_id: identification.device_id,
    risk_score: identification.risk_score,
    signals: identification.signals.map((s) => ({ name: s.name, weight: s.weight })),
    flags: identification.detection_flags,
    connection_type: identification.connection_type,
    source: identification.source,
  };
}

const HISTORY_PLACEHOLDER_KEY = 'sec_00000000-00000000-00000000';

/**
 * Normalizes one raw History API row with the SDK's own History normalizer (signal slugs from
 * score_details, flags from the is_* columns), by serving the row from memory: no network access.
 */
export async function normalizeHistoryRow(row: JsonObject): Promise<Identification> {
  const offline = new ShieldLabs({
    apiKey: HISTORY_PLACEHOLDER_KEY,
    baseUrl: 'http://127.0.0.1',
    maxRetries: 0,
    fetch: () =>
      Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ data: [row], total: 1 })),
      }),
  });
  const page = await offline.history.search('request_id', NIL_UUID, { limit: 1 });
  return page.data[0] as Identification;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Reads an already normalized identification or a webhook `data` object. Entries of `signals`
 * without a name or a numeric weight are skipped; a numeric weight that is not an integer is an
 * error, as is a risk_score outside the valid values.
 */
function fromNormalizedObject(obj: JsonObject, source: ExplainInput['source']): ExplainInput {
  const score = checkRiskScore(obj.risk_score, 'risk_score');
  const signals: ExplainInput['signals'] = [];
  if (Array.isArray(obj.signals)) {
    obj.signals.forEach((entry: unknown, index) => {
      if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.weight !== 'number') {
        return;
      }
      signals.push({
        name: entry.name,
        weight: checkWeight(entry.weight, `signals[${index}].weight`),
      });
    });
  }
  const rawFlags = isObject(obj.detection_flags) ? obj.detection_flags : {};
  const flags = Object.fromEntries(
    DETECTION_FLAG_KEYS.map((flag) => [flag, rawFlags[flag] === true]),
  );
  return {
    request_id: optionalString(obj.request_id),
    device_id: optionalString(obj.device_id),
    risk_score: score,
    signals,
    flags,
    connection_type: optionalString(obj.connection_type),
    source,
  };
}

/**
 * Accepts the shapes a user is likely to paste: a normalized identification (from this server or
 * a ShieldLabs server SDK), a webhook event or its `data` object, or a raw History API row.
 */
export async function parseIdentificationInput(input: unknown): Promise<ExplainInput> {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ToolInputError(
        'identification is not valid JSON. Pass a JSON object or its JSON text.',
      );
    }
  }
  if (!isObject(value)) {
    throw new ToolInputError('identification must be a JSON object.');
  }

  let obj = value;
  let source: ExplainInput['source'] = 'input';
  if (typeof obj.event_type === 'string') {
    if (!isObject(obj.data)) {
      throw new ToolInputError(
        `A ${code(obj.event_type, { maxLength: 60 })} event without a data object carries no identification (webhook.ping has none).`,
      );
    }
    obj = obj.data;
    source = 'webhook';
  } else if (Array.isArray(obj.data)) {
    throw new ToolInputError(
      'This looks like a History API page. Pass one identification (one item of data), or use request_id.',
    );
  } else if (isObject(obj.identification)) {
    // Output of shieldlabs_get_identification with response_format=json.
    obj = obj.identification;
  }

  if ('risk_score' in obj) return fromNormalizedObject(obj, source);
  if ('score' in obj || 'score_details' in obj) {
    // Every History row carries its score; a missing score is unknown, not a Risk Score of 0.
    if (!('score' in obj)) {
      throw new ToolInputError(
        'This History API row has score_details but no score. Paste the whole row, including score, or use request_id.',
      );
    }
    checkRiskScore(obj.score, 'score');
    const input = fromIdentification(await normalizeHistoryRow(obj));
    for (const signal of input.signals) checkWeight(signal.weight, 'Every score_details Value');
    return input;
  }
  throw new ToolInputError(
    'identification has no risk_score (normalized identification or webhook data) and no score (History API row). Pass one of those shapes, or use request_id.',
  );
}

export const ExplanationSchema = z.object({
  request_id: nullableString('Request ID of the explained identification, when known'),
  risk_score: z.number().int(),
  risk_band: RiskBandSchema,
  band_range: z.string(),
  band_meaning: z.string(),
  signals: z.array(
    z.object({
      name: z.string(),
      weight: z.number().int(),
      label: z.string(),
      meaning: z.string(),
      reading: nullableString(
        'How to read the risk signal next to others; null outside the catalog',
      ),
      typical_weight: z.number().int().nullable(),
      related_flag: nullableString('Detection flag that usually comes with the risk signal'),
      in_catalog: z.boolean(),
    }),
  ),
  detection_flags: z.array(
    z.object({ flag: z.string(), label: z.string(), scored: z.boolean(), meaning: z.string() }),
  ),
  connection_type: z
    .object({ value: z.string(), label: z.string(), meaning: z.string() })
    .nullable(),
  notes: z.array(z.string()),
  source: z.enum(['history', 'webhook', 'input']),
  truncated: z
    .boolean()
    .optional()
    .describe('Only present (true) when this server shortened the explanation'),
  truncation_message: z
    .string()
    .optional()
    .describe('What was shortened: risk signals left out, or long pasted values cut'),
});

export type Explanation = z.infer<typeof ExplanationSchema>;

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Builds the explanation: band, weighted risk signals with meanings, flags and caveats. At most
 * `maxSignals` risk signals are explained, and pasted values that are too long are cut.
 */
export function explain(input: ExplainInput, maxSignals = MAX_SIGNALS): Explanation {
  const score = Math.trunc(input.risk_score);
  const band = bandOf(score);
  const shown = Math.min(input.signals.length, MAX_SIGNALS, Math.max(0, maxSignals));
  let longNames = 0;
  let escapedValues = false;
  // Pasted values can hold any text: invisible and control characters become visible escapes,
  // then the value is cut to `max` characters as serialized in JSON.
  const bound = (value: string, max: number): { text: string; cut: boolean } => {
    const escaped = escapeInvisible(value);
    if (escaped !== value) escapedValues = true;
    const text = cutSerialized(escaped, max);
    return { text, cut: text !== escaped };
  };
  const signals = input.signals.slice(0, shown).map((signal) => {
    const info = riskSignalInfo(signal.name);
    const { text: name, cut } = bound(signal.name, MAX_SIGNAL_NAME_LENGTH);
    if (cut) longNames += 1;
    return {
      name,
      weight: Math.trunc(signal.weight),
      label: info?.label ?? name,
      meaning: info?.meaning ?? UNKNOWN_SIGNAL_MEANING,
      reading: info?.reading ?? null,
      typical_weight: info?.typical_weight ?? null,
      related_flag: info?.related_flag ?? null,
      in_catalog: info !== undefined,
    };
  });
  const requestId =
    input.request_id === null ? null : bound(input.request_id, MAX_PASTED_VALUE_LENGTH);
  const connectionValue =
    input.connection_type === null ? null : bound(input.connection_type, MAX_PASTED_VALUE_LENGTH);
  const flags = DETECTION_FLAG_KEYS.filter((flag) => input.flags[flag] === true).map((flag) => {
    const info = detectionFlagInfo(flag);
    return { flag, label: info.label, scored: info.scored, meaning: info.meaning };
  });

  const notes: string[] = [];
  if (band === 'rate_limited') {
    notes.push(
      'Skip the rate_limited entry when you log or count risk signals: it only marks the ban.',
    );
  }
  if (input.flags.search_bot === true) {
    notes.push('Known search-engine crawler: its Risk Score is set to 0 whatever else was seen.');
  }
  if (input.device_id === NIL_UUID) {
    notes.push('The all-zero device ID means no usable device signals reached ShieldLabs.');
  }
  if (signals.some((s) => !s.in_catalog)) {
    notes.push(
      'Some risk signal names are not in this server catalog (newer or less common risk signals). Their weights still counted.',
    );
  }
  const names = input.signals.map((s) => s.name);
  if (new Set(names).size < names.length) {
    notes.push(
      'A risk signal name can repeat: an earlier result for the same device and IP address can be carried forward with a partial weight, and a late network check adds a correction.',
    );
  }
  const shortened: string[] = [];
  if (shown < input.signals.length) {
    const reason =
      shown < Math.min(input.signals.length, MAX_SIGNALS)
        ? ` to keep the response under ${CHARACTER_LIMIT.toLocaleString('en-US')} characters`
        : '';
    const sentence = `Only the first ${shown} of ${input.signals.length} risk signals are explained${reason}.`;
    notes.push(sentence);
    shortened.push(sentence);
  }
  if (longNames > 0) {
    shortened.push(
      `${longNames} risk signal ${longNames === 1 ? 'name was' : 'names were'} cut to ${MAX_SIGNAL_NAME_LENGTH} characters.`,
    );
  }
  if (requestId?.cut === true) {
    shortened.push(`request_id was cut to ${MAX_PASTED_VALUE_LENGTH} characters.`);
  }
  if (connectionValue?.cut === true) {
    shortened.push(`connection_type was cut to ${MAX_PASTED_VALUE_LENGTH} characters.`);
  }
  if (escapedValues) {
    notes.push(
      'Invisible or control characters in the request ID, the connection type or risk signal names are shown as \\u escapes.',
    );
  }
  notes.push(
    'The weights are the ones this identification carried; ShieldLabs can change weights over time. The Risk Score is capped at 100 and follows combination rules, so read risk_score for the total and never add up weights yourself.',
    'Branch on risk_score and detection_flags; risk signal names are for display and logs.',
  );

  const connection =
    connectionValue === null || connectionValue.text === ''
      ? null
      : connectionTypeInfo(connectionValue.text);

  return {
    request_id: requestId === null ? null : requestId.text,
    risk_score: score,
    risk_band: band,
    band_range: bandRange(band),
    band_meaning:
      band === 'rate_limited'
        ? RATE_LIMIT_MARKER_NOTE
        : `${bandInfo(band).meaning} Typical handling: ${lowerFirst(bandInfo(band).typical_handling)}`,
    signals,
    detection_flags: flags,
    connection_type: connection,
    notes,
    source: input.source,
    ...(shortened.length > 0 ? { truncated: true, truncation_message: shortened.join(' ') } : {}),
  };
}

/**
 * The explanation and its markdown, with as many risk signals as fit: both renderings (markdown
 * and the JSON of the structured content) stay under the character limit.
 */
export function buildExplanation(input: ExplainInput): {
  explanation: Explanation;
  markdown: string;
} {
  let maxSignals = Math.min(input.signals.length, MAX_SIGNALS);
  for (;;) {
    const explanation = explain(input, maxSignals);
    const markdown = explanationMarkdown(explanation);
    const size = Math.max(markdown.length, JSON.stringify(explanation).length);
    if (size <= CHARACTER_LIMIT || maxSignals === 0) return { explanation, markdown };
    // Shrink in proportion to the overshoot (with a margin for the notes), at least by one.
    const target = Math.floor((maxSignals * CHARACTER_LIMIT * 0.9) / size);
    maxSignals = Math.max(0, Math.min(maxSignals - 1, target));
  }
}

export function explanationMarkdown(explanation: Explanation): string {
  const heading =
    explanation.risk_band === 'rate_limited'
      ? `# Rate-limit marker ${explanation.risk_score} (not a Risk Score)`
      : `# Risk Score ${explanation.risk_score}: ${explanation.risk_band} (${explanation.band_range})`;
  const lines = [heading, ''];
  if (explanation.request_id !== null)
    lines.push(`Request ID: ${code(explanation.request_id)}`, '');
  lines.push(explanation.band_meaning, '');
  if (explanation.truncation_message !== undefined) {
    lines.push(`Note: ${explanation.truncation_message}`, '');
  }
  lines.push('## Weighted risk signals');
  if (explanation.signals.length === 0) {
    lines.push('No weighted risk signals: nothing added to the Risk Score.');
  } else {
    lines.push('| Risk signal | Weight | Meaning |', '|---|---:|---|');
    for (const signal of explanation.signals) {
      const name = code(signal.name, { table: true });
      const label = signal.in_catalog ? `${signal.label} (${name})` : name;
      lines.push(
        `| ${label} | ${signedWeight(signal.weight)} | ${signal.meaning.replace(/\|/g, '\\|')} |`,
      );
    }
  }
  lines.push('', '## Detection flags set');
  if (explanation.detection_flags.length === 0) lines.push('None.');
  for (const flag of explanation.detection_flags) {
    lines.push(
      `- ${flag.label} (${code(flag.flag)}${flag.scored ? '' : ', informational'}): ${flag.meaning}`,
    );
  }
  if (explanation.connection_type !== null) {
    lines.push(
      '',
      '## Connection type',
      `${code(explanation.connection_type.value)}: ${explanation.connection_type.meaning}`,
    );
  }
  lines.push('', '## Notes', ...explanation.notes.map((note) => `- ${note}`));
  return lines.join('\n');
}
