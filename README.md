# @shieldlabs/mcp

MCP server that lets AI assistants read ShieldLabs identifications, search their history, explain Risk Scores and verify webhook signatures.

[![CI](https://github.com/ShieldLabs-ai/shieldlabs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ShieldLabs-ai/shieldlabs-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@shieldlabs/mcp.svg)](https://www.npmjs.com/package/@shieldlabs/mcp)

## How it fits

1. **Browser.** The ShieldLabs agent runs an identification and hands your page a request ID.
2. **Your backend.** It sends the request ID with the protected action (signup, login, checkout)
   and reads the verdict from the History API, or receives it in a signed `identification.scored`
   webhook.
3. **Decision.** Your backend acts on the Risk Score, the three risk bands, the detection flags and
   the identifiers (for example, how many accounts one device has opened).

This server puts steps 2 and 3 in reach of an MCP client such as Claude Desktop, Claude Code,
Cursor or VS Code: ask "review request 02f1d973-..." or "which accounts used this device?" and the
assistant reads the answers from the History API. Every tool is read-only. New to ShieldLabs?
Start free at [app.shieldlabs.ai](https://app.shieldlabs.ai).

## Install

```bash
npx -y @shieldlabs/mcp
```

Node.js 20 or later. The server speaks stdio by default; MCP clients start it for you (see Quick
start). A container image is published as `ghcr.io/shieldlabs-ai/shieldlabs-mcp`.

## Quick start

1. Copy the **Private API Key** (`sec_...`) of your domain from the analytics dashboard at
   [app.shieldlabs.ai](https://app.shieldlabs.ai). It reads the identifications of that one domain.
2. Add the server to your client.

   **Claude Code**

   ```bash
   claude mcp add --transport stdio shieldlabs --env SHIELDLABS_API_KEY=sec_your_private_key -- npx -y @shieldlabs/mcp
   ```

   **Claude Desktop** (`claude_desktop_config.json`), **Cursor** (`.cursor/mcp.json`) and other
   clients that use the `mcpServers` format:

   ```json
   {
     "mcpServers": {
       "shieldlabs": {
         "command": "npx",
         "args": ["-y", "@shieldlabs/mcp"],
         "env": { "SHIELDLABS_API_KEY": "sec_your_private_key" }
       }
     }
   }
   ```

   **VS Code** (`.vscode/mcp.json`), with the key requested at start-up:

   ```json
   {
     "inputs": [
       { "type": "promptString", "id": "shieldlabs-api-key", "description": "ShieldLabs Private API Key", "password": true }
     ],
     "servers": {
       "shieldlabs": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "@shieldlabs/mcp"],
         "env": { "SHIELDLABS_API_KEY": "${input:shieldlabs-api-key}" }
       }
     }
   }
   ```

3. Ask: "Review the ShieldLabs request `<request ID>`", or run the `review_request` prompt.

More client setups, HTTP and Docker: [`examples/`](examples).

## Guide

### Review one request

Give the assistant the request ID your backend received with a signup, login or payment.
`shieldlabs_get_identification` reads the verdict, and `shieldlabs_explain_risk_score` explains the
band, each weighted risk signal and the detection flags in plain language. The `review_request`
prompt runs these steps and ends with a suggested action (allow, step-up challenge, manual review
or block) and the reasons.

Scoring is asynchronous: the History row appears about 1 to 3 seconds after the browser call and
can be refined for up to about 10 seconds while follow-up checks finish.
`shieldlabs_get_identification` waits for a brand-new identification (up to about 10 seconds in
total) and returns the first version of the row it finds, so a verdict read in those first seconds
can still be refined: read it again (`wait: false` is enough) once `observed_at` is about 10
seconds in the past for the final state. Integrations that start the identification when the user
begins the action (for example on the first interaction with the form) find the row stored by the
time the form arrives.

A request ID that is not found means the identification is unverified, never clean: it may be too
new, it may come from another domain (a Private API Key reads one domain), or it was issued while
the visitor IP was over the ingest rate limit (such request IDs are never stored).

### Investigate an account, a device or an IP address

`shieldlabs_summarize_entity` aggregates the recent identifications of one User HID, device ID,
visitor ID, cookie ID or IPv4 address: distinct devices, accounts, visitors, countries, IP
addresses and connection types (with the most frequent values), the highest and average Risk
Score, the worst band, rate-limit markers, and the detection flags and risk signals seen, with
counts. The result is labelled as computed from the returned history window, not as a ShieldLabs
verdict. It reads the 100 most recent identifications by default (`max_items`, at most 500; each
100 cost one History API request). `shieldlabs_search_history` lists the individual
identifications with paging.

Typical questions:

| Question | Lookup |
|---|---|
| How many accounts used this device? | `summarize_entity` with `device_id` |
| How many devices does this account use, and from which countries? | `summarize_entity` with `user_hid` |
| Did this IP address send automated traffic or hit the rate limit? | `summarize_entity` with `ip` |
| What happened, in order, on this account? | `search_history` with `user_hid` |

The `investigate_user` prompt chains these lookups for one User HID. Account counts leave out the
User HID values that do not name an account: `null`, `"anonymous"`, `"fail"`, `"-1"` and
`"unknown"`.

User HIDs travel as one URL path segment, so a User HID that contains `/` cannot be searched: the
tools refuse it with an explanation instead of returning an empty page (as they refuse `.` and
`..`). User HIDs made of URL-safe characters, such as the hex output of `userHid()` in the server
SDKs, avoid this.

### Debug a webhook endpoint

`shieldlabs_verify_webhook_signature` checks a received delivery: the raw body, the
`X-Shield-Signature` header and the endpoint secret (or `SHIELDLABS_WEBHOOK_SECRET`). When the
signature does not match, it tests the usual mistakes (a re-serialized or pretty-printed body,
decoded `&` escapes, an added newline) and tells you which one explains the mismatch. It never
returns a secret or an expected signature.

While you rotate an endpoint's secret, give both secrets separated by commas, in the argument or in
`SHIELDLABS_WEBHOOK_SECRET` (for example `whsec_new_secret,whsec_old_secret`). The delivery is
valid when any of them matches, and `matched_secret` says which one did.

ShieldLabs sends one delivery per identification today, with a 1-second timeout and no retries.
Later releases add retries that resend identical bytes, so make the handler idempotent on
`data.request_id` and answer 2xx within 1 second. Use the History API for guaranteed reads and for
the latest state: a History row can be refined after the webhook was sent, and the webhook is not
sent again.

### Plan an integration

The `integrate_shieldlabs` prompt loads the ShieldLabs setup skill and walks the assistant through
the browser identification, the server-side verdict, webhooks and a verification checklist. On
stdio it fetches the skill from the `shieldlabs-skills` release this server version was tested with
(tag `v1.0.0`, never a branch), with a 3-second timeout and a 200 KB limit. It uses its built-in
guide when that fails, with `--offline`, and always over HTTP.

### Run over HTTP

```bash
SHIELDLABS_API_KEY=sec_your_private_key SHIELDLABS_MCP_TOKEN=your_long_random_token \
  npx -y @shieldlabs/mcp --transport http --port 8787
```

The endpoint is `http://127.0.0.1:8787/mcp` (streamable HTTP, stateless, JSON responses). Every
request needs `Authorization: Bearer <SHIELDLABS_MCP_TOKEN>`; when the variable is unset, the
server generates a token and prints it once to stderr. `GET /health` answers `{"status":"ok"}`
without authentication. Over HTTP the `integrate_shieldlabs` prompt always uses its built-in guide.
See [`examples/http`](examples/http).

### Limit the tools

`--tools` exposes only the tools you list, with or without the `shieldlabs_` prefix:

```bash
npx -y @shieldlabs/mcp --tools get_identification,explain_risk_score
```

The identification resource follows `shieldlabs_get_identification`, and the prompts only mention
tools that are exposed.

## Reference

### Configuration

| Variable | Required | Purpose |
|---|---|---|
| `SHIELDLABS_API_KEY` | For the History API tools | Private API Key (`sec_...`) of one domain. Without it the server starts with the offline tools only and explains how to add the key |
| `SHIELDLABS_SECRET_KEY` | No | Secret Key of the domain, for the Management API |
| `SHIELDLABS_DOMAIN` | No | Registered domain for the Management API, for example `example.com`. With `SHIELDLABS_SECRET_KEY` it enables `shieldlabs_get_domain_profile` |
| `SHIELDLABS_WEBHOOK_SECRET` | No | Default endpoint signing secret (`whsec_...`) for `shieldlabs_verify_webhook_signature`; several separated by commas while you rotate |
| `SHIELDLABS_API_BASE_URL` | No | History API origin, default `https://account.shieldlabs.ai` (development and tests). Must be https; plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]` |
| `SHIELDLABS_MANAGEMENT_BASE_URL` | No | Management API origin, default `https://api.shieldlabs.ai` (development and tests). Must be https; plain http is accepted only for `localhost`, `127.0.0.1` and `[::1]` |
| `SHIELDLABS_MCP_TOKEN` | For `--transport http` | Bearer token for the HTTP endpoint; generated and printed once when unset |

| Flag | Default | Purpose |
|---|---|---|
| `--transport <stdio\|http>` | `stdio` | Transport |
| `--port <number>` | `8787` | HTTP port |
| `--host <address>` | `127.0.0.1` | HTTP bind address |
| `--allowed-origins <list>` | none | Browser origins allowed to call the HTTP endpoint; requests with any other `Origin` header are refused |
| `--tools <list>` | all available | Allowlist of tools |
| `--offline` | off (on with `--transport http`) | Never fetch remote content (the setup prompt uses its built-in guide) |
| `--help`, `--version` | | |

### Tools

Every tool is annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
accepts `response_format` (`markdown` by default, or `json`) and returns structured content with an
output schema. Responses stay under 25,000 characters, in the text and in the structured content:
long pages are shortened with a notice and a `next_offset` to continue, and values longer than
1,000 characters as serialized in JSON (for example a landing URL reported by a browser) are cut
and listed in `truncated_fields`. Invisible and control characters in values (zero-width and
bidirectional characters, Unicode tag characters, variation selectors) are replaced by visible
`\uXXXX` or `\u{XXXXX}` escapes and listed in `escaped_fields`, so a value cannot hide text from
the person reading the output. A cut or escaped value differs from the stored one: do not search
by it.

| Tool | Needs | Input | Returns |
|---|---|---|---|
| `shieldlabs_get_identification` | API key | `request_id`, `wait` (default `true`: up to about 10 seconds in total) | The first stored version of the identification with its band, or an error that explains "not scored yet" |
| `shieldlabs_search_history` | API key | `type` (`request_id`, `user_hid`, `device_id`, `visitor_id`, `ip`, `session_id`, `cookie_id`), `value`, `limit` 1-100 (20), `offset` (0) | Identifications newest first, `total`, `count`, `has_more`, `next_offset` |
| `shieldlabs_summarize_entity` | API key | `type` (`user_hid`, `device_id`, `visitor_id`, `ip`, `cookie_id`), `value`, `max_items` 1-500 (100) | Aggregates of the returned history window (see Guide) |
| `shieldlabs_explain_risk_score` | Nothing (API key for `request_id`) | `request_id`, or `identification` (normalized identification, webhook event or `data`, or raw History row) | Band, weighted risk signals with meanings, detection flags, connection type, notes |
| `shieldlabs_get_domain_profile` | Secret Key and domain | none | Remaining included identifications, masked keys, creation date (cached 60 s, one request shared by concurrent calls) |
| `shieldlabs_verify_webhook_signature` | Nothing | `payload`, `signature_header`, `secret` (optional), `payload_encoding` (`utf8` or `base64`) | Valid or not, checks, the event summary, and what to fix |
| `shieldlabs_current_time` | Nothing | `timezone` (optional IANA name) | Current UTC time and the local time, for freshness checks |

Identifications follow the model of the ShieldLabs server SDKs (webhook field names) without the
raw payload, plus `risk_band`. `signals[].description` is always `null`: the History API's score
details are internal text, so this server returns the signal slug and weight, as webhooks do.

### Resources

| URI | Content |
|---|---|
| `shieldlabs://identifications/{request_id}` | One identification as JSON (read once, without waiting) |
| `shieldlabs://contract/identification` | JSON Schema of the normalized identification |
| `shieldlabs://contract/webhook-event` | JSON Schema of a webhook delivery, with the signature scheme |
| `shieldlabs://reference/risk-signals` | Catalog of risk signals, detection flags and connection types in plain language |
| `shieldlabs://reference/risk-bands` | The three bands and the 999 rate-limit marker |

### Prompts

| Prompt | Arguments | Purpose |
|---|---|---|
| `integrate_shieldlabs` | none | Integration plan from the setup skill of the `shieldlabs-skills` release `v1.0.0` (fetched on stdio with a short timeout and cached for an hour; built-in guide offline and over HTTP) |
| `investigate_user` | `user_hid` | Investigate one account: band, devices and other accounts on them, countries, flags, suggested action |
| `review_request` | `request_id` | Review one identification: verdict, risk signals, freshness, device and account history, suggested action |

### Reading the results

- **Risk Score**: integer 0-100. Bands: **trusted 0-29**, **suspicious 30-59**, **dangerous
  60-100**. A value above 100 (sent as 999) is the rate-limit marker: the visitor IP was
  temporarily banned after too many identifications. It is not a score and not a band.
- **Risk signals** are the weighted reasons behind a score. Weights can be negative (a late network
  check corrects an earlier one) and signal names are an open set. Branch on `risk_score` and
  `detection_flags`; never add up weights yourself.
- **Identifiers**: `device_id` survives cleared cookies and private windows, and the all-zero device
  ID means no usable device signals. `user_hid` is `"anonymous"` for anonymous checks.
- A missing identification means unverified, never clean.

## Security

- **Keys stay in the environment.** The server never logs keys or secrets and never returns them,
  not even in error messages. Pass keys through the client's `env` settings, not command-line
  flags.
- **Read-only.** No tool changes anything in ShieldLabs. The Management API tool reads the profile
  only.
- **Visitor data is data.** User HIDs, landing URLs, referrers and UTM values in identifications
  come from visitors' browsers. Markdown output renders every API value as inert inline code,
  invisible and control characters are shown as visible escapes in every format, json responses
  carry an `untrusted_data_note`, and the server instructions tell the assistant to treat these
  strings as data, never as instructions.
- **A shared History API budget.** The History API allows about 15 requests per second per domain,
  shared with your own backend, which polls it for new verdicts. This server sends at most 2
  History API requests at a time and 5 per second for the whole process (every tool call and every
  HTTP client) and queues the rest; after a 429 every queued request waits 1 to 5 seconds
  (`Retry-After`).
- **Encrypted API calls.** Base URL overrides must use https, except on loopback addresses.
- **HTTP transport**: bearer token required on every request (constant-time comparison), requests
  with an unlisted `Origin` refused, `Host` checked on loopback binds, 1 MB body limit, and a
  health endpoint without data. The default bind address is `127.0.0.1`. The server warns at start
  when `SHIELDLABS_MCP_TOKEN` has fewer than 32 characters (use `openssl rand -hex 32`).
- **Webhook debugging** reports whether a signature matches; it never returns the secret or a
  signature it computed.
- **Network access**: the ShieldLabs APIs, plus one request to `raw.githubusercontent.com` for the
  setup skill of the pinned `shieldlabs-skills` release when the `integrate_shieldlabs` prompt runs
  on stdio (skip it with `--offline`; never over HTTP). No telemetry.

## Errors and retries

Tool errors come back as MCP tool results with `isError: true` and a message that names the fix.
API calls use the retries of `@shieldlabs/node`: connection errors, timeouts, 429 and 5xx are
retried with backoff; 400, 401, 402, 403 and 404 are not, and a Management API 429 is never
retried: after one, `shieldlabs_get_domain_profile` answers from memory until the 10-minute block
ends. History API requests wait in the shared budget described under Security. Cancelling a tool
call in the client stops its API requests, including the wait for a new verdict and requests still
in the queue.

The wait for a new verdict (`shieldlabs_get_identification` with `wait: true`, and
`shieldlabs_explain_risk_score` with a `request_id`) works on one budget of about 10 seconds:

- It polls at once, then after 250 ms, 500 ms, 1 s, 1.5 s and then every 2 s. The last poll runs
  when the budget ends. Each poll is one request, without retries.
- A 429, a 5xx, a connection error or a timeout does not end the wait. After a 429 the next poll
  waits the longest of the scheduled step, 1 second and `Retry-After` capped at 10 seconds, cut
  short at the end of the budget. When `Retry-After`, capped at 10 seconds, is longer than the time
  left, the tool reports the rate limit at once.
- When the budget ends, the tool reports the error of the last poll if it failed, and "not scored
  yet" otherwise.
- 400, 401, 403 and 404 end the wait at once: a wrong key or base URL does not heal.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Only the offline tools are listed (explain, verify, current time) | `SHIELDLABS_API_KEY` is not set for the server process. Add it to the client's `env` settings and restart the client |
| "rejected the key (HTTP 401)" | Use the Private API Key (`sec_...`) of the domain, not its Public Key or Secret Key, and check that the domain is enabled |
| "No identification ... is available yet" | The identification is new (retry in a few seconds), it belongs to another domain, or its request ID was issued while the visitor IP was over the ingest rate limit (never stored) |
| "user_hid values that contain "/" cannot be searched" | The History API cannot match such a User HID. Look the account up by the `device_id` or `visitor_id` of one of its identifications |
| "rate limit was reached (HTTP 429)" | The History API allows about 15 requests per second per domain, shared with your backend. Wait, then prefer `summarize_entity` with a modest `max_items` |
| Domain profile: 429 | The Management API allows about 15 calls per minute per IP and then blocks the IP for 10 minutes. Wait 10 minutes |
| Domain profile: 401 | `SHIELDLABS_DOMAIN` must equal the registered domain, for example `example.com` |
| "answered 404" | `SHIELDLABS_API_BASE_URL` must be an origin such as `https://account.shieldlabs.ai`, without a path |
| "must be an https URL" at start | A base URL override uses plain http on a host other than `localhost`, `127.0.0.1` or `[::1]`. Use https |
| "cannot be sent in an HTTP header" or "domain must be ASCII" at start | A key or the domain contains a line break, a space or a non-ASCII character. Copy the key again from the analytics dashboard; write an internationalized domain in its punycode form (`xn--...`) |
| HTTP 401 on `/mcp` | Send `Authorization: Bearer <SHIELDLABS_MCP_TOKEN>` |
| HTTP 403 on `/mcp` | The browser origin is not in `--allowed-origins`, or the request used a host name other than localhost |
| Nothing happens on stdio | Logs go to stderr; stdout carries the protocol. Run `npx -y @shieldlabs/mcp --help` to check the install |

## Compatibility

- Node.js 20, 22 and 24 (tested in CI).
- MCP TypeScript SDK 1.x: protocol revisions supported by the SDK, tools with output schemas,
  resources, resource templates and prompts. Transports: stdio and streamable HTTP.
- History API and Management API as documented at [docs.shieldlabs.ai](https://docs.shieldlabs.ai);
  webhook schema version `2026-06-01`.
- Semantic versioning: breaking changes only in a new major version.

## Development

```bash
npm ci
# Until @shieldlabs/node is published, build its tarball in a checkout of shieldlabs-node:
(cd ../shieldlabs-node && npm ci && npm pack)
npm install --no-save ../shieldlabs-node/shieldlabs-node-1.0.0.tgz
npm run typecheck
npm run lint
npm test -- --coverage
npm run build
node dist/index.js --help
npm run smoke            # the built server over stdio against the fake History API
```

`@shieldlabs/node` is bundled into `dist/` at build time, so the published package depends only on
`@modelcontextprotocol/sdk` and `zod`.

### Fake History API

`scripts/mock-history-api.mjs` serves a deterministic dataset (`test/mock-data/`, generated by
`scripts/generate-mock-data.mjs`) as a fake History API and Management API:

```bash
npm run build
node scripts/mock-history-api.mjs --port 8788
# in another terminal: the MCP Inspector CLI passes environment variables with -e
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  -e SHIELDLABS_API_KEY=sec_evaldata-mockdata-00000001 \
  -e SHIELDLABS_API_BASE_URL=http://127.0.0.1:8788 \
  --method tools/list
```

`npm run smoke` does the same without extra downloads: it starts the fake API, runs the built
server over stdio with the MCP SDK client and calls its tools, resources and prompts.

### Evaluation

[`evaluation.xml`](evaluation.xml) holds ten realistic questions in the format of the MCP
builder evaluation harness, answerable from the mock dataset. `test/evaluation.test.ts` answers
each one through the MCP tools and checks the expected answer, so the file stays correct. To run
the harness itself (it drives Claude and needs an Anthropic API key):

```bash
pip install anthropic mcp
export ANTHROPIC_API_KEY=your_key
npm run build
node scripts/mock-history-api.mjs --port 8788 &
python evaluation.py -t stdio -c node -a dist/index.js \
  -e SHIELDLABS_API_KEY=sec_evaldata-mockdata-00000001 SHIELDLABS_API_BASE_URL=http://127.0.0.1:8788 \
  -o evaluation-report.md evaluation.xml
```

`evaluation.py` is `scripts/evaluation.py` of the mcp-builder skill in
[github.com/anthropics/skills](https://github.com/anthropics/skills). It imports `connections.py`
from its own folder, so copy both files into the root of this repository before running the
command above (they are not part of it), or run it from that `scripts` folder with absolute paths
to `dist/index.js` and `evaluation.xml`. Pass `-m <model>` to choose the model.

See [CONTRIBUTING.md](CONTRIBUTING.md). Documentation: [docs.shieldlabs.ai](https://docs.shieldlabs.ai).
Support: [contact@shieldlabs.ai](mailto:contact@shieldlabs.ai).

## License

[MIT](LICENSE)
