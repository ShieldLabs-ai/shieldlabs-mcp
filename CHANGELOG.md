# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
