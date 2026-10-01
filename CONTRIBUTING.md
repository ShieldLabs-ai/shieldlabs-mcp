# Contributing

Thanks for helping improve the ShieldLabs MCP server. Questions and bug reports: open an issue or
write to [contact@shieldlabs.ai](mailto:contact@shieldlabs.ai).

## Set up

```bash
npm ci
(cd ../shieldlabs-node && npm ci && npm pack)   # until @shieldlabs-ai/node is published
npm install --no-save ../shieldlabs-node/shieldlabs-ai-node-1.0.0.tgz
```

## Before you open a pull request

```bash
npm run typecheck
npm run lint            # eslint and prettier --check
npm test -- --coverage  # coverage must stay at or above 85 %
npm run build && node dist/index.js --help
npm run test:worker     # the hosted mode in the Workers runtime (Node.js 22 or later)
npm run worker:check    # bundles like wrangler deploy --dry-run --env dev; no Node.js built-ins
```

The CI workflow runs the commands above on Node.js 20, 22 and 24, plus the stdio smoke test
(`npm run smoke`). It does not run the two Worker commands yet: run them yourself, on Node.js 22
or later, before you open a pull request that touches `src/public/`, `src/worker.ts` or
`wrangler.jsonc`. They do not need `@shieldlabs-ai/node`.

## Guidelines

- Tools stay read-only and prefixed with `shieldlabs_`. Every tool needs a zod input schema with
  descriptions and bounds, an output schema, annotations and an actionable error for each failure.
- Values that come from the API can contain text written by visitors. Render them with `code()` in
  markdown, pass identifications through `toIdentificationOutput()` and other API strings through
  `escapeInvisible()` before they reach any output, and bound their size.
- Every History API request goes through the client built in `createContext()`, so it stays
  within the process-wide request budget.
- Never log or return keys or secrets.
- Public mode (`src/public/`, `src/worker.ts`) accepts ShieldLabs access tokens (`slat_...`) only
  and checks each one with `GET /mcp/v1/ping` of the account API, signed with `MCP_GATEWAY_KEY`
  and a fresh nonce per request (`src/public/gateway.ts`; its test pins the signature vector of
  the account API). It offers `shieldlabs_check_connection` only: the account API has no MCP data
  methods yet, and access tokens are not accepted on the History API. API keys are a later step.
- Code reachable from `src/worker.ts` runs on Cloudflare Workers: use Web APIs (`fetch`,
  `crypto.subtle`, streams), not Node.js modules, and do not import `src/context.ts` or
  `@shieldlabs-ai/node`; `npm run worker:check` fails on a Node.js import. Nothing may outlive a
  request except the cache of accepted tokens, keyed by the SHA-256 of the token.
- Tests use the shared fixtures in `test/fixtures/` and the mock dataset in `test/mock-data/`. Do
  not edit either by hand: change `scripts/generate-mock-data.mjs` and run it.
- Documentation style: plain technical English, "risk signals" for the weighted reasons behind a
  score, and the three risk bands trusted 0-29, suspicious 30-59, dangerous 60-100.
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`).

## Releases

`@shieldlabs-ai/node` is bundled into `dist/`. Until it is published on npm, the workflows build it
from its repository: CI from the `main` branch and the release workflow from the `v1.0.0` tag
(`SHIELDLABS_NODE_REF` in each workflow), and both stop unless it is a 1.x version. So merge and
tag the 1.x SDK before this package. While that repository is private, add a read-only token as
the `SHIELDLABS_NODE_TOKEN` secret.

Maintainers push a `v*` tag that matches `package.json`. The release workflow checks, builds and
packs with read-only permissions, then publishes the package to npm with provenance (environment
`npm`, secret `NPM_TOKEN`) and pushes the image with provenance and an SBOM to
`ghcr.io/shieldlabs-ai/shieldlabs-mcp` (environment `ghcr`). Add required reviewers to both
environments in the repository settings to approve each release. Re-running the workflow is safe:
a version that is already on npm is skipped and the image tags are pushed again. After both are
live, `server.json` can be published to the MCP registry with `mcp-publisher publish`.

The setup skill fetched by the `integrate_shieldlabs` prompt is pinned to a `shieldlabs-skills`
release (`SETUP_SKILL_REF` in `src/constants.ts`). Tag that release before releasing this package,
and move the pin only to a release you have checked.
