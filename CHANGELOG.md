# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Grok client example (`examples/grok`) for the same local server Claude Code starts, plus the
  configured hosted URL for Grok. Current preview availability and deployed version must be
  verified separately; these notes describe source functionality, not deployment.
- Public mode, for the hosted multi-tenant server (`--transport http --mode public`, or the
  Cloudflare Worker entry `src/worker.ts`). Users connect by signing in with their ShieldLabs
  account (OAuth); a request without an access token gets a 401 with the `resource_metadata`
  challenge, and the protected resource metadata (RFC 9728, without scopes) is served at
  `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`.
- Every access token (`slat_...`) is checked with `GET /mcp/v1/ping` of the ShieldLabs account
  API, signed with the `X-Shield-Gateway` header (key `MCP_GATEWAY_KEY`, a fresh nonce per
  request). An accepted token is remembered for 60 seconds under its SHA-256 hash; refusals are
  never remembered. Any other credential, API keys included, gets the 401 without being sent
  anywhere. Every operation still revalidates the live token and account ownership at the backend,
  even when the ingress ping cache is hit.
- Public mode implements 21 tools: connection check, domain list/get/create/patch/delete/server-key
  rotation, ten webhook lifecycle operations, history search, identification read, entity summary
  and risk explanation. Four static resources, a domain-scoped identification template and three
  prompts are included. Exact names and schemas are in the packaged
  [hosted operations reference](HOSTED-OPERATIONS.md). Local stdio/API-key and single-tenant HTTP
  tools remain read-only; the local `--tools` allowlist is rejected in public mode.
- Hosted writes require explicit `confirm:true` for deletes, disables, rotations and webhook URL
  changes. Domain/webhook create and rotate mask credentials by default; only an installer should
  opt into `include_secret:true`, then privately store the structured one-time sensitive result.
  MCP clients can record that response in transcripts; this is not transcript prevention.
- Hosted calls use only `/mcp/v1`. GET/ping retain v1 signatures; mutations use HMAC-SHA256 v2
  binding the method, exact request URI, token hash and SHA-256 of the raw serialized body,
  including empty bodies. Bodies are bounded to 1 MiB and mutations are never retried.
- Webhook names accept at most 80 trimmed Unicode characters and URLs at most 512 trimmed UTF-8
  bytes. Hosted history supports IPv4 and IPv4-mapped IPv6, not pure IPv6; unsupported addresses
  are rejected locally with an actionable error.
- CORS and Origin checks for browser clients, one JSON-RPC message per request, rate limits per
  token and per address (pings for tokens that are not in the cache are limited per address before
  the account API is asked), and one JSON log line per request without tokens, signatures or
  bodies.
- `wrangler.jsonc` with the `dev` (`dev.mcp.shieldlabs.ai`) and `production`
  (`mcp.shieldlabs.ai`) environments, Worker tests in workerd (`npm run test:worker`), a bundle
  check (`npm run worker:check`), `--trust-proxy` for the container, and `examples/hosted`.

## [1.0.0] - 2026-09-30

First release.

### Added

- MCP server `@shieldlabs-ai/mcp` (bin `shieldlabs-mcp`) built on the MCP TypeScript SDK and
  `@shieldlabs-ai/node`, which is bundled into the package.
- Tools, all read-only: `shieldlabs_get_identification` (waits up to about 10 seconds in total
  for the verdict of a new identification and returns the first stored version, which can still
  be refined for up to about 10 seconds after the browser call; a 429, a 5xx or a network error
  does not end the wait), `shieldlabs_search_history` (seven lookup types, paging with
  `has_more` and `next_offset`), `shieldlabs_summarize_entity` (aggregates of the returned history
  window of an account, device, visitor, cookie or IP address: the 100 most recent identifications
  by default, at most 500), `shieldlabs_explain_risk_score` (band, weighted risk signals,
  detection flags and connection type in plain language from a bundled catalog),
  `shieldlabs_get_domain_profile` (Management API, cached for 60 seconds, one request shared by
  concurrent calls, and a 429 remembered for the 10-minute block),
  `shieldlabs_verify_webhook_signature` (with hints for common body changes; several secrets
  separated by commas while a secret is rotated, in the argument or in
  `SHIELDLABS_WEBHOOK_SECRET`, with the position of the one that matches; an event whose
  `risk_score` is outside 0-100 and the 999 marker is reported without a Risk Score) and
  `shieldlabs_current_time`.
- Markdown and JSON response formats, output schemas with structured content, a 25,000 character
  limit for the text and the structured content (with truncation notices, and `truncated_fields`
  for values cut by their size in JSON), and actionable error messages. Cancelling a tool call
  stops its API requests.
- Values reported by browsers are shown as data: invisible and control characters become visible
  `\u` escapes (listed in `escaped_fields`) in markdown, JSON, structured content and resources,
  and json responses with identifications carry an `untrusted_data_note`.
- One History API budget for the whole process: at most 2 requests in flight and 5 per second,
  queued in order, and a 429 pauses every queued request for 1 to 5 seconds, so the tools leave
  room for the site's own backend.
- User HIDs are sent in the URL path form the History API matches, including values with
  `@ + = : , ; $ &`. A User HID that contains `/`, or is `.` or `..`, is refused with an
  explanation, because the History API cannot search it.
- Resources: `shieldlabs://identifications/{request_id}`, `shieldlabs://contract/identification`,
  `shieldlabs://contract/webhook-event`, `shieldlabs://reference/risk-signals` and
  `shieldlabs://reference/risk-bands`.
- Prompts: `integrate_shieldlabs` (the setup skill of the `shieldlabs-skills` release `v1.0.0`,
  fetched on stdio only, with a 200 KB limit and a built-in fallback), `investigate_user` and
  `review_request`.
- Transports: stdio, and streamable HTTP with a bearer token (with a warning for tokens shorter
  than 32 characters), origin and host checks and a health endpoint.
- Offline mode without `SHIELDLABS_API_KEY`, `--tools` allowlist and `--offline`. Base URL overrides
  must use https, except on loopback addresses.
- Container image, MCP registry metadata (`server.json`), client configuration examples, and an
  evaluation set with a fake History API for the evaluation harness.
