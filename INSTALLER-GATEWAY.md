# Hosted AI installer gateway (disabled)

Local implementation on `codex/oauth-installer-gateway`; operations5 base preserved. No deployment or paid requests. Node HTTP has no installer route.

## Required before enablement

`INSTALLER_ENABLED` is `"false"` in every Wrangler environment. Only exact `"true"` enables it. Missing/invalid secret `INSTALLER_ANTHROPIC_API_KEY`, or missing/failing `RL_INSTALLER_IP`, means 503. No real `.env` or credential files are read.

**The existing shared OAuth consent rollout remains unresolved. Do not enable yet.** Consent must disclose transmission of explicitly selected source to Anthropic; revoke/close old grants and require renewed consent. Portal authorization must reject legacy-consent grants. Confirm atomic stable-user/global budgets and operator workspace model access first. Existing read-only MCP consent cannot silently expand. No enablement or grant migration occurs here.

Verified 2026-10-03: [official SDK README](https://github.com/anthropics/anthropic-sdk-typescript) names `claude-opus-5-5` and Cloudflare Workers support; [official package metadata](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/package.json) names SDK **0.131.0**, now pinned exactly with registry integrity in package-lock. [Official SDK docs](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) document messages.create/custom fetch/timeouts/retries. [Official model overview](https://platform.claude.com/docs/en/models/overview) lists Opus 5.5. Access in the operator's authenticated workspace remains unverified, a live prerequisite.

## Contracts

POST `/installer/plan` is on the same configured `publicOrigin` as MCP, using existing `Bearer slat_<43 base64url characters>`. JWT/site/API keys/refresh tokens are refused locally. No new audience, `/api/v1`, cookies or client-token forwarding to Anthropic. Existing `/mcp` OAuth challenge is retained. CORS reflects allowed HTTPS/loopback origins without wildcard credentials; replies are no-store.

Every request first consumes the fail-closed `RL_INSTALLER_IP` binding: 10 per minute per trusted CF-Connecting-IP (unknown addresses share a bucket). Shared Claude egress has no exemption. This ingress limiter is separate from the global atomic paid quota.

Before each paid attempt, signed v2 POST `/mcp/v1/installer/authorize` sends exactly `{"request_id":"<fresh crypto.randomUUID()>"}`. Fresh 16-byte nonce and existing X-Shield-Gateway signing cover method, path, token hash and exact body hash. Portal receives no source. No cached ping/TokenCache/redirect/retry.

Only 200 `{"authorized":true,"request_id":"<same UUID>"}` permits a call. Portal 401/429/503/409 stays that refusal status; all other statuses, malformed/mismatched answers or network failures become 503. Response is bounded at 4,096 bytes / 3 seconds. Error bodies are discarded.

**Portal contract:** atomically reserve BOTH daily stable-user and global quotas in shared Redis before 200; reject duplicate request IDs, revoked/wrong-audience/stale-consent principals; Redis down means fail closed. Rotation/new grants cannot reset a user's quota. Failed/aborted/provider-rejected/invalid-proposal attempts retain reservations. No refunds. Gateway consumes this contract; it does not implement or prove Portal Redis concurrency/consent migration. A token-only check is incompatible with enablement.

ClientJSON has exactly version:1, stack, objective and project. Six frontend stacks: vanilla/react/next/vue/angular/svelte. Project files are path/content; optional package contains optional dependencies/scripts string records. No unknown client/model/provider/tools/system keys. AgentResult has summary, edits [{path,after,reason?}] and verification [{command,args}]; no before or unknown fields.

| Constant / policy | Limit |
| --- | --- |
| MAX_BODY_BYTES | 262,144 actual UTF-8 bytes, including package |
| MAX_FILES | 32, case-insensitively unique paths |
| MAX_FILE_BYTES | 32,768 UTF-8 bytes per source or proposed file |
| MAX_SOURCE_BYTES | 98,304 UTF-8 bytes aggregate input, separately aggregate edits |
| MAX_OBJECTIVE_BYTES | 2,048 UTF-8 bytes, nonempty |
| Path | 240 characters, portable relative ASCII |
| Package entries | 128 each in dependencies/scripts |
| Metadata key / value | 128 / 2,048 UTF-8 bytes |
| MAX_METADATA_BYTES | 32,768 UTF-8 bytes serialized package |
| MAX_EDITS / verification | 40 / 8 |
| Summary / optional reason | 2,000 chars and 4,096 UTF-8 bytes / 2,048 UTF-8 bytes |
| MAX_PROPOSAL_BYTES | 262,144 before JSON parse |
| MAX_PROVIDER_BYTES | 1,048,576 actual upstream bytes, including reasoning/errors/envelope |
| MAX_OUTPUT_TOKENS | 8,192, reasoning included |
| REQUEST_TIMEOUT_MS | 90,000 total from body through SDK response |
| BODY_TIMEOUT_MS / AUTHORIZE_TIMEOUT_MS | 10,000 / 3,000 inside total deadline |

Invalid UTF-8/lone surrogates/NUL source are refused. Source extensions: js/jsx/ts/tsx/mjs/cjs/vue/svelte/html/css/scss. Exclude spaces, JSON, hidden/config/env/credential/token/password paths, traversal, backslashes, empty segments and generated/vendor directories. Known token patterns and exact runtime OAuth/provider/gateway values are checked throughout input/output. Secret heuristics supplement client source review, not replace it.

**CLI owner handoff:** copy exported `isHostedSourcePath` in src/installer/schema.ts into the hosted-view filter before provisioning/confirmation; report excluded count. If over limits, request a smaller explicit selection, never silently truncate. Generic CLI permits spaces/JSON/config paths; sending its unfiltered view gives 400. Gateway never silently drops files. CLI validateProposal/before-image checks remain required. No CLI writes were made here.

## Provider and output policy

Official SDK 0.131.0 makes a single non-streaming messages.create request. Custom fetch fences SDK traffic to POST `https://api.anthropic.com/v1/messages`, manual redirects, fixed server headers and server key. maxRetries:0 and timeout:90000; no tools/fallback/beta/client system. Raw response chunks are bounded before SDK parsing. Wrapper independently refuses a second paid fetch per authorization. SDK logs disabled; request abort/deadline reaches fetch and body readers. No background paid tasks.

Fixed model **claude-opus-5-5**, replacing Sonnet by user correction. Default adaptive reasoning stays inside 8,192 tokens. Accept only fixed-model end_turn with text and optional thinking/redacted_thinking. Reasoning is excluded from client outputs; tools/refusals/truncation/partial messages/other content fail closed without retry. Plain JSON only (no prose/fences); proposal locally validated for bounds/duplicates/paths/secrets.

Verification only copies exact npm/run/build|typecheck|check|test|lint entries present in package scripts. Nothing runs server-side. Script implementations are untrusted and require local review before execution. New files are possible; CLI checks they are truly new and not excluded existing files.

Trusted prompt names exports verified against actual local package entry points and public interfaces: JS load; React/Next ShieldLabsProvider/useShieldLabs; Vue createShieldLabs/useShieldLabs; Angular provideShieldLabs/injectShieldLabs; Svelte setShieldLabs/getShieldLabs. Framework load()/identify() interfaces are verified. Supplied generated starters remain untrusted data, never policy. Gateway imports no CLI code.

Safe JSON logs contain only route `/installer/plan`, status, optional fixed errorcode and durationMs. No request/response/source/credentials/headers/caught error text. MCP metadata/tools/challenge/CORS remain intact.

## Offline verification / deviations

Run typecheck, lint, unit tests, test:worker and worker:check. Preserved MCP base needs local 1.x @shieldlabs-ai/node tarball installed without saving, as in its existing CI. Contract tests run through the real pinned SDK in Node and workerd with fake Portal/provider HTTP; no paid call.

Verified locally 2026-10-03: 309 unit tests and 106 workerd runtime tests pass; typecheck, lint, build and diff whitespace checks pass. Coverage: lines 96.88%, branches 91.30%, statements 95.72%, functions 95.06%. Worker dry-run bundle: 427.72 KiB gzip, no Node built-in imports. HEAD remains 485035a. This evidence does not establish deployed OAuth/Portal consent or real provider execution.

Skill deviations: explicit user prohibition overrides paid fallback defaults; bounded non-streaming SDK response; existing Workers compatibility date/handwritten binding pattern retained; installer-only safe observability. Source/proposal limits are stricter than generic CLI. Shared Redis atomicity/renewed consent are backend prerequisites, not claims verified in this worktree.
# Optional OpenBroker provider

The existing Anthropic configuration stays the default. To opt in to OpenBroker,
set `INSTALLER_PROVIDER=openbroker`, supply the server secret
`INSTALLER_OPENBROKER_API_KEY`, and explicitly select
`INSTALLER_OPENBROKER_MODEL`. The accepted model IDs are listed in
`src/installer/openbroker.ts`; catalog changes require review and tests.
The client cannot select a model, upstream URL or provider.

This integration uses OpenBroker, not Perplexity. Selected application source is
sent to OpenBroker after the application's source-sharing confirmation. Never
send environment files, credentials or unrelated repositories. No automatic
provider fallback, retries or redirects are permitted. The same fresh OAuth
authorization and quota reservation run before each request.

OpenBroker bills in GNK and may charge multiple upstream attempts. A request-count
quota is not a dollar cap. Before enabling paid traffic, establish a GNK allowance
and a defensible conversion to the approved spending limit; do not assume an
OpenAI-shaped response's token usage equals settled cost.

This is a bounded planning adapter, not yet an iterative agent runtime.
