import {
  SETUP_SKILL_CACHE_MS,
  SETUP_SKILL_MAX_BYTES,
  SETUP_SKILL_TIMEOUT_MS,
  SETUP_SKILL_URL,
} from '../constants.js';
import type { GuideResponse, ServerContext } from '../context.js';

/** Concise integration guide used when the published setup skill cannot be fetched. */
export const BUILT_IN_SETUP_GUIDE = `# Integrate ShieldLabs (built-in guide)

ShieldLabs identifies visitors and scores risk in three steps: the browser runs an identification
and gets a request ID, the backend reads the verdict for that request ID, and the backend decides
what to do with the protected action (signup, login, checkout). Confirm version-sensitive details
against https://docs.shieldlabs.ai.

## 1. Plan

- Detect the stack: frontend framework (plain JS, React, Next.js, Vue or Nuxt, Angular, Svelte or
  SvelteKit) and backend language (Node.js, Python, Go, PHP, Java, .NET).
- List the protected actions. Each one gets exactly one fresh identification.
- Keys from the analytics dashboard (https://app.shieldlabs.ai), one domain each:
  - SHIELDLABS_PUBLIC_KEY: browser only (framework prefixes such as VITE_ or NEXT_PUBLIC_ are fine).
  - SHIELDLABS_API_KEY: Private API Key (sec_...), backend only.
  - SHIELDLABS_WEBHOOK_SECRET: endpoint signing secret (whsec_...), backend only.
  Never put the Private API Key, the Secret Key or the signing secret in a client bundle.

## 2. Browser: get a request ID

\`\`\`ts
import { load, type LoadOptions } from '@shieldlabs-ai/js';

const options: LoadOptions = { publicKey: import.meta.env.VITE_SHIELDLABS_PUBLIC_KEY };
load(options).catch(() => {}); // start loading now, but never await it at the top level

// At the protected action, not on every render or route change:
async function submitSignup(form: Record<string, string>, userHidFromYourServer: string) {
  let requestId: string | null = null;
  try {
    const agent = await load(options); // the loaded agent, or a new attempt after a failed load
    ({ requestId } = await agent.identify({ userId: userHidFromYourServer }));
  } catch {
    // No identification (a content blocker, a network error): send the action anyway.
  }
  await fetch('/signup', { method: 'POST', body: JSON.stringify({ ...form, requestId }) });
}
\`\`\`

- The framework packages (@shieldlabs-ai/react, /vue, /angular, /svelte, /next) load the same agent
  through a provider and offer an identify helper with loading and error state.
- Identify once per protected action. Each call is a billable identification, and the ingest
  allows about 15 requests per minute per visitor IP.
- Start the identification when the user begins the action (agent.identifyOnInteraction(form)
  starts it on the first interaction with the form): the History row appears about 1 to 3 seconds
  after the browser call, so the verdict is usually stored when the form arrives.
- userId is a User HID computed on your server (step 4), never a raw email address or account ID.
- The agent loads from https://cdn.shieldlabs.ai only; allow its origins in your Content Security
  Policy (see the docs).

## 3. Backend: read and apply the verdict

\`\`\`ts
import { ShieldLabs, evaluateIdentification } from '@shieldlabs-ai/node';

const shieldlabs = new ShieldLabs({ apiKey: process.env.SHIELDLABS_API_KEY! });

// Waits up to 10 s in total for the row and returns the first version it finds. The row appears
// about 1 to 3 s after the browser call and can be refined for up to about 10 s.
const identification = await shieldlabs.identifications.get(requestId);

// Claim the request ID first with an atomic insert-if-absent (Redis SET NX, a unique key in SQL),
// so that two requests with the same ID cannot both pass; then evaluate.
const firstUse = identification !== null && (await claimRequestId(identification.request_id));
const verdict = evaluateIdentification(identification, {
  maxAge: 5 * 60_000,
  isReplay: () => !firstUse,
});
if (!verdict.ok) return refuse(verdict.reason); // missing, replayed, stale, rate_limited, ...
\`\`\`

Server SDKs with the same model exist for Python (shieldlabs), Go, PHP, Java and .NET. Rules:
- A missing identification means unverified, never clean.
- Refuse reused request IDs and identifications older than your freshness window (5 minutes here).
- Branch on risk_score (bands: trusted 0-29, suspicious 30-59, dangerous 60-100) and
  detection_flags. 999 is a rate-limit marker, not a score. Never add up signal weights.
- The all-zero device ID means no usable device signals.

## 4. User HID

\`\`\`ts
import { userHid } from '@shieldlabs-ai/node';
// hidSecret: a long random value created once and kept on your server (changing it changes every User HID).
const hid = userHid(user.id, hidSecret); // HMAC-SHA256, 64 lowercase hex characters
\`\`\`

Pass it to the browser and use it for History API lookups by user_hid. A User HID travels as one
URL path segment in those lookups, so it cannot contain "/" or be "." or ".."; the hex output of
userHid() is always searchable.

## 5. Webhooks (optional)

\`\`\`ts
import { webhooks } from '@shieldlabs-ai/node';

// One secret, or several separated by commas while you rotate: any of them verifies.
const secrets = process.env.SHIELDLABS_WEBHOOK_SECRET!.split(',').map((secret) => secret.trim());
const event = webhooks.constructEvent(rawBody, req.headers['x-shield-signature'], secrets);
if (event.event_type === 'identification.scored') enqueue(event.data); // idempotent on data.request_id
\`\`\`

Verify the raw body before parsing and answer 2xx within 1 second. ShieldLabs sends one delivery
per identification today (1 second timeout, no retries); later releases add retries that resend
identical bytes, so make the handler idempotent on data.request_id. Use the History API for
guaranteed reads and for the latest state (a History row can be refined after the webhook was
sent, and the webhook is not sent again).

## 6. Verify

- The browser sends a request ID with every protected action; nothing else about risk reaches it.
- The backend refuses missing, reused, stale, rate-limited, automated and dangerous identifications.
- No secret key appears in client code or logs.
- Test on a registered domain: on localhost the page still gets a request ID, but the
  identification is rejected and the backend never finds it.
- Test with the shieldlabs_get_identification tool: the request ID from a real signup returns a verdict.
`;

export interface SetupGuide {
  text: string;
  /** Where the text came from: the skill URL, or "built-in". */
  source: string;
}

/**
 * The body as UTF-8 text, or undefined when it is larger than `maxBytes`. A streamed body is read
 * only up to the limit and then cancelled.
 */
export async function readCappedText(
  response: GuideResponse,
  maxBytes: number,
): Promise<string | undefined> {
  const body = response.body;
  if (body === undefined || body === null) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The published setup skill, pinned to the skills release of this server version, fetched with a
 * short timeout and a size limit and cached for an hour. Falls back to the built-in guide when
 * offline mode is on (always over HTTP) or the fetch fails.
 */
export async function loadSetupGuide(ctx: ServerContext): Promise<SetupGuide> {
  const builtIn: SetupGuide = { text: BUILT_IN_SETUP_GUIDE, source: 'built-in' };
  if (ctx.config.offline || ctx.guideFetch === undefined) return builtIn;

  const now = ctx.now();
  if (ctx.guideCache !== undefined && now - ctx.guideCache.fetchedAt < SETUP_SKILL_CACHE_MS) {
    return ctx.guideCache.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SETUP_SKILL_TIMEOUT_MS);
  try {
    const response = await ctx.guideFetch(SETUP_SKILL_URL, {
      signal: controller.signal,
      headers: { Accept: 'text/plain, text/markdown' },
    });
    if (!response.ok) return builtIn;
    const text = await readCappedText(response, SETUP_SKILL_MAX_BYTES);
    if (text === undefined || text.trim() === '') return builtIn;
    const guide = { text, source: SETUP_SKILL_URL };
    ctx.guideCache = { value: guide, fetchedAt: now };
    return guide;
  } catch {
    return builtIn;
  } finally {
    clearTimeout(timer);
  }
}
