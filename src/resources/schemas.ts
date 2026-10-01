import { SIGNALS } from '@shieldlabs-ai/node';
import { CONNECTION_TYPE_CATALOG } from '../catalog/connection-types.js';
import { DETECTION_FLAG_CATALOG, DETECTION_FLAG_KEYS } from '../catalog/detection-flags.js';
import { MAX_SIGNAL_NAME_LENGTH, MAX_VALUE_LENGTH } from '../format.js';
import { MAX_SIGNALS_PER_IDENTIFICATION } from '../identification.js';

const UUID_REGEX = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const KNOWN_SLUGS = Object.values(SIGNALS).join(', ');
const CONNECTION_TYPES = CONNECTION_TYPE_CATALOG.map((info) => info.value).join(', ');

const ipInfo = (what: string, empty: string) => ({
  type: 'object',
  description: what,
  required: ['ip', 'country'],
  additionalProperties: true,
  properties: {
    ip: {
      type: 'string',
      description: `Dotted IPv4 address, or ${empty} when none is known (IPv6 visitors appear as ${empty})`,
    },
    country: {
      type: 'string',
      description:
        'English country name from IP intelligence (for example "Germany"), or "" when unknown',
    },
  },
});

const detectionFlags = (description: string, required: readonly string[]) => ({
  type: 'object',
  description,
  required: [...required],
  additionalProperties: { type: 'boolean' },
  properties: Object.fromEntries(
    DETECTION_FLAG_CATALOG.map((info) => [
      info.flag,
      {
        type: 'boolean',
        description: `${info.meaning}${info.scored ? '' : ' Informational (weight 0).'}`,
      },
    ]),
  ),
});

const TRAFFIC_KEYS = [
  'channel',
  'referrer_domain',
  'landing_url',
  'click_id_type',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;

const trafficSource = {
  type: 'object',
  description:
    'Where the visit came from. Every value is a string, "" when absent. landing_url, referrer_domain and the utm_* values are reported by the visitor\'s browser.',
  required: [...TRAFFIC_KEYS],
  additionalProperties: true,
  properties: {
    channel: {
      type: 'string',
      description:
        'Google Ads, Meta, TikTok, LinkedIn, X, Pinterest, Microsoft Ads, Organic Search, Search bot, Referral, Direct, Other, or ""',
    },
    referrer_domain: {
      type: 'string',
      description: 'Referrer domain without www., or a crawler name for search bots',
    },
    landing_url: { type: 'string', description: 'Landing URL without the fragment' },
    click_id_type: {
      type: 'string',
      description: 'gclid, gbraid, wbraid, msclkid, ttclid, fbclid, or ""',
    },
    utm_source: { type: 'string', description: 'Lowercased' },
    utm_medium: { type: 'string', description: 'Lowercased' },
    utm_campaign: { type: 'string' },
    utm_content: { type: 'string' },
    utm_term: { type: 'string' },
  },
};

const IDENTIFIER_FIELDS = {
  request_id: { type: 'string', description: 'UUID of the identification, created in the browser' },
  visitor_id: {
    type: 'string',
    description:
      'Server-side visitor identifier (sticky to the device); the all-zero UUID is possible',
  },
  device_id: {
    type: 'string',
    description: 'Server-side device identifier; the all-zero UUID means no usable device signals',
  },
  session_id: {
    type: 'string',
    description: 'One visit on one origin; the all-zero UUID is possible',
  },
  cookie_id: {
    type: 'string',
    description: 'First-party browser identifier kept by the agent; the all-zero UUID is possible',
  },
};

const REQUIRED_IDENTIFICATION_FIELDS = [
  'request_id',
  'visitor_id',
  'device_id',
  'session_id',
  'cookie_id',
  'user_hid',
  'domain',
  'public_ip',
  'local_ip',
  'connection_type',
  'os',
  'browser',
  'device_type',
  'traffic_source',
  'risk_score',
  'signals',
  'detection_flags',
  'observed_at',
  'source',
];

/** JSON Schema of the normalized Identification (the shape the ShieldLabs server SDKs return). */
export const IDENTIFICATION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'shieldlabs://contract/identification',
  title: 'Identification',
  description:
    "One identification (one run of the ShieldLabs agent in one browser), normalized from a History API row or from the data object of an identification.scored webhook. Property names follow the webhook contract. This server's tools return this shape without raw and add risk_band.",
  type: 'object',
  required: REQUIRED_IDENTIFICATION_FIELDS,
  additionalProperties: true,
  properties: {
    ...IDENTIFIER_FIELDS,
    user_hid: {
      type: ['string', 'null'],
      description:
        'The site\'s User HID (hashed or pseudonymous account ID) as sent by the browser: "anonymous" for anonymous checks; "fail", "-1" and "unknown" are other non-account values; null when it was empty',
    },
    domain: { type: 'string', description: 'Registered domain of the site' },
    public_ip: ipInfo('Public IP address of the HTTP request', '""'),
    local_ip: ipInfo('Local IP address the browser reports', '""'),
    connection_type: {
      type: 'string',
      description: `Known values: ${CONNECTION_TYPES}. Unknown strings are kept as sent.`,
    },
    os: {
      type: 'string',
      description: 'For example Windows, Mac OS X, Linux, Android, IOS (iPhone), ChromeOS, Unknown',
    },
    browser: {
      type: 'string',
      description: 'For example Chrome, Safari, Firefox, Microsoft Edge; an open set',
    },
    device_type: { type: 'string', description: 'desktop, mobile, tablet or unknown' },
    traffic_source: trafficSource,
    risk_score: {
      type: 'integer',
      minimum: 0,
      description:
        'Risk Score 0-100. A value above 100 (999) is the rate-limit marker, never a score.',
    },
    risk_band: {
      enum: ['trusted', 'suspicious', 'dangerous', 'rate_limited'],
      description:
        'Added by this server from risk_score (not on the wire): trusted 0-29, suspicious 30-59, dangerous 60-100, rate_limited for the 999 marker.',
    },
    signals: {
      type: 'array',
      description:
        'Weighted risk signals behind the Risk Score, in order. Names can repeat; weights can be negative.',
      items: {
        type: 'object',
        required: ['name', 'weight', 'description'],
        additionalProperties: true,
        properties: {
          name: {
            type: 'string',
            description: `Signal slug. An open set; known values: ${KNOWN_SLUGS}`,
          },
          weight: {
            type: 'integer',
            description: 'What the signal added to the Risk Score. Never sum weights yourself.',
          },
          description: {
            type: ['string', 'null'],
            description:
              "Server description of the signal. The server SDKs fill it for History API rows (null for webhooks); this server's tools always return null because the text is internal and not meant for display. Never branch on it.",
          },
        },
      },
    },
    detection_flags: detectionFlags(
      'The 19 detection flags. A flag the server did not send is false.',
      DETECTION_FLAG_KEYS,
    ),
    observed_at: {
      type: ['string', 'null'],
      description:
        'When the identification was observed, RFC 3339 UTC with milliseconds; null only for an unparsable timestamp',
    },
    source: {
      enum: ['webhook', 'history'],
      description: 'Which payload the identification was built from',
    },
    raw: { type: 'object', description: "The original payload. Omitted by this server's tools." },
    truncated_fields: {
      type: 'array',
      items: { type: 'string' },
      description: `Added by this server only when it shortened values (not on the wire): paths of the fields cut to ${MAX_VALUE_LENGTH.toLocaleString('en-US')} characters (${MAX_SIGNAL_NAME_LENGTH} for risk signal names), and "signals" when only the first ${MAX_SIGNALS_PER_IDENTIFICATION} risk signals are listed. A shortened value is a prefix of the stored one.`,
    },
  },
} as const;

/** JSON Schema of a webhook delivery body (the envelope), with the signature scheme in the description. */
export const WEBHOOK_EVENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'shieldlabs://contract/webhook-event',
  title: 'WebhookEvent',
  description:
    'Body of a ShieldLabs webhook delivery: POST with Content-Type application/json and the header X-Shield-Signature: sha256=<lowercase hex HMAC-SHA256 of the raw body, keyed with the full endpoint signing secret including its whsec_ prefix>. Verify the raw bytes before parsing; there is no timestamp or delivery-ID header. Answer 2xx within 1 second and make handlers idempotent on data.request_id. Events: identification.scored (with data) and webhook.ping (Verify in the analytics dashboard, no data). Accept unknown event types and schema versions. The Test delivery from the analytics dashboard omits the browser_automation and search_bot flags: treat missing flags as false.',
  type: 'object',
  required: ['event_type', 'schema_version', 'created_at'],
  additionalProperties: true,
  properties: {
    event_type: {
      type: 'string',
      description: 'identification.scored, webhook.ping, or a newer event type',
    },
    schema_version: { type: 'string', description: 'Currently "2026-06-01"' },
    created_at: { type: 'string', description: 'RFC 3339 UTC, up to 9 fractional digits' },
    data: { $ref: '#/$defs/IdentificationData' },
  },
  allOf: [
    {
      if: {
        properties: { event_type: { const: 'identification.scored' } },
        required: ['event_type'],
      },
      then: { required: ['data'] },
    },
  ],
  $defs: {
    IdentificationData: {
      type: 'object',
      description: 'data of identification.scored. Every key is always present.',
      required: [
        'request_id',
        'visitor_id',
        'device_id',
        'session_id',
        'cookie_id',
        'user_hid',
        'domain',
        'public_ip',
        'local_ip',
        'connection_type',
        'os',
        'browser',
        'device_type',
        'traffic_source',
        'risk_score',
        'signals',
        'detection_flags',
        'observed_at',
      ],
      additionalProperties: true,
      properties: {
        request_id: { ...IDENTIFIER_FIELDS.request_id, pattern: UUID_REGEX },
        visitor_id: { ...IDENTIFIER_FIELDS.visitor_id, pattern: UUID_REGEX },
        device_id: { ...IDENTIFIER_FIELDS.device_id, pattern: UUID_REGEX },
        session_id: { ...IDENTIFIER_FIELDS.session_id, pattern: UUID_REGEX },
        cookie_id: { ...IDENTIFIER_FIELDS.cookie_id, pattern: UUID_REGEX },
        user_hid: {
          type: ['string', 'null'],
          description:
            'null only when the stored User HID is empty; "anonymous" for anonymous checks',
        },
        domain: { type: 'string', description: 'Registered site domain' },
        public_ip: ipInfo('Public IP address of the HTTP request', '""'),
        local_ip: ipInfo('Local IP address the browser reports', '""'),
        connection_type: { type: 'string', description: `Known values: ${CONNECTION_TYPES}` },
        os: { type: 'string' },
        browser: { type: 'string' },
        device_type: { type: 'string', description: 'desktop, mobile, tablet or unknown' },
        traffic_source: trafficSource,
        risk_score: {
          type: 'integer',
          minimum: 0,
          description:
            'Risk Score 0-100, or 999 as the rate-limit marker (then signals is [{"name":"rate_limited","weight":999}])',
        },
        signals: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'weight'],
            additionalProperties: true,
            properties: {
              name: {
                type: 'string',
                description: `Signal slug. An open set; known values: ${KNOWN_SLUGS}`,
              },
              weight: { type: 'integer' },
            },
          },
        },
        // Not required one by one: the Test delivery from the analytics dashboard omits two flags,
        // and a parser must accept it.
        detection_flags: detectionFlags(
          'The 19 detection flags as booleans. Production deliveries always carry all 19; the Test delivery from the analytics dashboard omits browser_automation and search_bot. Treat a missing flag as false.',
          [],
        ),
        observed_at: {
          type: 'string',
          description: 'RFC 3339 UTC, identical to the envelope created_at',
        },
      },
    },
  },
} as const;
