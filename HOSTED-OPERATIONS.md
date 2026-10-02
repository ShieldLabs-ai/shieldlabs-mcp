# Hosted operations reference

This reference describes the tools implemented in this source version. A running
deployment may expose an earlier version; use MCP discovery to inspect it.
Source availability does not imply deployment, registry publication or live
account verification.

## Tool inputs

All tool input objects reject unknown fields. `UUID` means a public UUID string,
never a database ID. `hostname` is a string of 1–253 characters without a scheme,
path or embedded credentials. `format` is `"markdown" | "json"`, default
`"markdown"`. Management operations return JSON. Optional fields are marked `?`.

| Exact tool name | Input type |
| --- | --- |
| `shieldlabs_check_connection` | `{}` (arguments may be omitted) |
| `shieldlabs_list_domains` | `{}` |
| `shieldlabs_get_domain` | `{domain_id: UUID}` |
| `shieldlabs_create_domain` | `{domain: hostname, allow_subdomains?: boolean, include_secret?: boolean = false}` |
| `shieldlabs_patch_domain` | `{domain_id: UUID, enabled?: boolean, allow_subdomains?: boolean, confirm?: true}`; at least one patch field; `enabled:false` requires `confirm:true` |
| `shieldlabs_delete_domain` | `{domain_id: UUID, confirm: true}` |
| `shieldlabs_rotate_server_key` | `{domain_id: UUID, confirm: true, include_secret?: boolean = false}` |
| `shieldlabs_list_webhooks` | `{domain_id: UUID}` |
| `shieldlabs_get_webhook` | `{domain_id: UUID, webhook_id: UUID}` |
| `shieldlabs_create_webhook` | `{domain_id: UUID, name: string[1..100], url: HTTPS_URL[1..2048], include_secret?: boolean = false}` |
| `shieldlabs_patch_webhook` | `{domain_id: UUID, webhook_id: UUID, name?: string[1..100], url?: HTTPS_URL[1..2048], confirm?: true}`; at least one patch field; URL requires `confirm:true` |
| `shieldlabs_delete_webhook` | `{domain_id: UUID, webhook_id: UUID, confirm: true}` |
| `shieldlabs_enable_webhook` | `{domain_id: UUID, webhook_id: UUID}` |
| `shieldlabs_disable_webhook` | `{domain_id: UUID, webhook_id: UUID, confirm: true}` |
| `shieldlabs_rotate_webhook_secret` | `{domain_id: UUID, webhook_id: UUID, confirm: true, include_secret?: boolean = false}` |
| `shieldlabs_verify_webhook` | `{domain_id: UUID, webhook_id: UUID}` |
| `shieldlabs_test_webhook` | `{domain_id: UUID, webhook_id: UUID}` |
| `shieldlabs_search_history` | `{type: Lookup, value: string[1..512], domain?: hostname, limit?: integer[1..100] = 20, offset?: integer[0..MAX_SAFE_INTEGER] = 0, response_format?: format}` |
| `shieldlabs_get_identification` | `{request_id: UUID, domain?: hostname, wait?: boolean = true, response_format?: format}` |
| `shieldlabs_summarize_entity` | `{type: Entity, value: string[1..512], domain?: hostname, max_items?: integer[1..500] = 100, response_format?: format}` |
| `shieldlabs_explain_risk_score` | `{request_id?: UUID, identification?: object or JSON string[0..500000], domain?: hostname, response_format?: format}`; exactly one of request_id/identification |

`Lookup = "request_id" | "user_hid" | "device_id" | "visitor_id" | "ip" |
"session_id" | "cookie_id"`. `Entity = "user_hid" | "device_id" | "visitor_id" |
"ip" | "cookie_id"`. Identifier values are encoded once. Slash, backslash, control
characters and dot segments are rejected; ID types require UUIDs. IP validity is
checked by the backend, which supports IPv4 and IPv6.

History domain selection is delegated to the backend for each read. Omission is
accepted only with exactly one enabled owned domain; otherwise an actionable
`domain_required` error asks for a hostname and lists safe available hostnames.
Management tools always require explicit public IDs, except list/create domain.

## Tool output types

Successful tools return `structuredContent` plus bounded text content. Each tool
publishes its JSON `outputSchema` through MCP discovery.

```ts
type Domain = {
  id: UUID; domain: string; public_key: string; server_key: string;
  enabled: boolean; allow_subdomains: boolean; domain_verified: boolean;
  created_at: string;
};
type Webhook = {
  id: UUID; name: string; url: string; secret: string; enabled: boolean;
  status: "pending" | "active" | "failing" | "verification_failed" | "disabled";
  created_at: string; updated_at: string; requests: integer;
  last_delivery_at: string | null;
};
type Sensitive = { sensitive: true; one_time: true; secret_handling: string };
type Truncated = { truncated?: true; truncation_message?: string };
type LookupResult = { type: Lookup; value: string };
```

- Check connection: `{connected: boolean, checked_at: string}`.
- Domain list: `{domains: Domain[]} & Truncated`; domain get/create/patch/rotate:
  `Domain`, optionally `& Sensitive` on opted-in create/rotate.
- Webhook list: `{webhooks: Webhook[]} & Truncated`; webhook get/create/patch/
  enable/disable/verify/rotate: `Webhook`, optionally `& Sensitive` on opted-in
  create/rotate.
- Deletes: `{deleted: true}`.
- Webhook test: `{delivered: boolean, status_code: integer, latency_ms: number,
  timed_out: boolean}`. Delivery failure can be a successful tool result with
  `delivered:false`.
- Search: `{lookup: LookupResult, total: integer, count: integer, offset: integer,
  limit: integer, has_more: boolean, next_offset?: integer,
  identifications: Identification[], untrusted_data_note: string} & Truncated`.
- Identification: `{found: true, identification: Identification,
  untrusted_data_note: string}`.
- Summary: `{lookup: {type: Entity,value:string}, computed_from:string,
  window:{identifications_analyzed:integer,total_matching:integer,max_items:integer,
  complete:boolean}, summary:Summary, untrusted_data_note:string}`.
- Risk explanation: the existing `ExplanationSchema` from `src/explain.ts`,
  including score/band, weighted signals, flag explanations, connection type,
  notes and source. `IdentificationOutputSchema` and `SummarySchema` are reused
  from `src/identification.ts` and `src/summarize.ts`; no debug/raw fields are
  exposed. Those full nested schemas are included in MCP discovery.

Dates from the backend are RFC3339 strings. `server_key` and `secret` are masked
as `"********"` by default. Only explicit `include_secret:true` on one of the four
credential-producing tools returns the raw credential in `structuredContent`,
with `Sensitive` metadata. Text content does not repeat it. The server cannot
prevent a client recording an opted-in result. The installer must write it
privately, not echo or log it. Credentials are not cached or retained in server
context. There is no secret-recovery operation.

## Resources and prompts

| Exact resource registration name | URI | Content |
| --- | --- | --- |
| `identification-schema` | `shieldlabs://contract/identification` | Identification JSON Schema |
| `webhook-event-schema` | `shieldlabs://contract/webhook-event` | Webhook event JSON Schema |
| `risk-signals` | `shieldlabs://reference/risk-signals` | Shared local risk catalog JSON |
| `risk-bands` | `shieldlabs://reference/risk-bands` | Shared three-band catalog JSON |
| `hosted-identification` | `shieldlabs://domains/{domain}/identifications/{request_id}` | `{identification: Identification}`; explicit hostname and UUID; read once |

| Exact prompt name | Arguments |
| --- | --- |
| `integrate_shieldlabs` | none |
| `investigate_user` | `{domain: hostname, user_hid: string[1..512]}` |
| `review_request` | `{domain: hostname, request_id: UUID}` |

Prompts return one user text message. Hosted integration instructions use the
registered operations without fetching remote instructions or accepting cabinet
credentials. Existing local stdio/API-key tools and resource URIs are unchanged.

## Annotations and transport behavior

GET/history/explain tools: read-only, non-destructive and idempotent.
Create, key/secret rotation, verify and test: non-idempotent. Patch, delete and
enable/disable are idempotent state operations (a repeat delete can return 404).
Delete, disable, rotation and both patch tools are conservatively destructive;
URL changes and domain disable require explicit confirmation at runtime. All
tools contact external account data, so `openWorldHint:true`.

- All external operation requests target `/mcp/v1`, using the request's access
  token. Read ping retains v1. Mutations use v2 with the exact serialized body's
  SHA-256, including empty-body POST and DELETE.
- Mutations are never retried. Identification polling alone retries transient
  failures with delays 250/500/1000/1500/2000 ms; 429 polling uses
  `min(Retry-After, 10 seconds)` and immediately rethrows when that pause cannot
  fit in the remaining wait budget. The manual error retains the server's
  advertised recommendation separately. Every poll uses a new nonce. The entire wait, including HTTP and
  delays, shares a hard 10-second budget; the final poll begins within that
  budget. Authentication/input errors stop polling immediately.
- Each authenticated MCP request has its own scheduler and credentials: at most
  2 backend reads in flight, 5 starts/second and 12 backend operations. Existing
  ingress token/address rate limiters remain the outer process/isolate budget.
  Scheduler timers are request-local because workerd cancels timers belonging
  to completed requests. There is no account data or domain-selection cache.
- HTTP attempts time out after 10 seconds. MCP/request cancellation aborts
  queued and active fetches and polling delays. Node client disconnects propagate
  to the Web Request signal. Listener/timer cleanup runs on completion.
- Upstream bodies and outgoing mutations are bounded to 1 MiB. Both text and
  structured tool responses are bounded to 25,000 characters. Error messages
  use controlled text; upstream errors and result bodies are never logged.
- The shared SDK is installed locally from a packed artifact, without changing
  package.json or lockfile semantics. The published CLI bundles it; workerd
  resolves its edge export. The History normalizer runs against in-memory rows,
  not against a legacy API endpoint.

## Verification and remaining evidence

Final local verification (2026-10-02): `npm test` passed 223 tests across 23
files; `npm run test:worker` passed 22 tests across 3 files. `npm run typecheck`,
`npm run lint`, `npm run build`, and `git diff --check` passed. The Worker dry-run
bundle contains no Node built-ins and is approximately 303.63 KiB compressed.
`dist/index.js` is rebuilt for the parent's process-level integration rerun.
The focused Retry-After test verifies an 8-second server recommendation with a
6-second total wait budget rethrows immediately, without a final retry.
HTTP disconnect cancellation is tested on a real Node loopback server.

Node and workerd suites use an actual MCP Client. A synthetic backend verifies
v1/v2 HMAC independently of production signing code for every registered
management method, exact bytes, escaped path/query, unique nonce, tampering and
replay. Other tests cover confirmation, secret defaults and opt-in, error safety,
account/domain isolation, normalization, summary/risk explanation, transient
polling, deadlines, cancellation, response/body caps and backend request budgets.

Parent owns independent review, QA, devex, the actual built CLI-to-MCP loopback
test, documentation synchronization, and any backend cross-component checks.
Backend deployment, real OAuth authorization/re-authorization, actual account
mutation and live webhook delivery remain separate release evidence. The broader
administrative consent text and existing-grant transition are rollout gates;
this worktree adds no scopes or consent bypass.

Parent reported a synthetic built-CLI-to-separate-built-MCP-process run passing
login/create/confirmed rotation/logout, four independently verified signed API
calls and no secret leakage. The final-artifact rerun remains parent-owned;
that synthetic fixture does not establish Go-backend or live-consent behavior.
