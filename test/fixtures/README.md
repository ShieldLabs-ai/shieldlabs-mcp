# Shared test fixtures

Shared test fixtures that every ShieldLabs server SDK passes. Do not edit them here.

They come from `contract/` in [shieldlabs-openapi](https://github.com/ShieldLabs-ai/shieldlabs-openapi/tree/main/contract): `contract-sync.json` maps each file, `.shieldlabs-contract.lock` records the release they come from, CI runs `python3 scripts/sync_contract.py --check`, and the `contract-sync.yml` workflow opens a pull request when a new release changes them.

| File | Used for |
|---|---|
| `history-page.json`, `history-empty.json` | History API 200 bodies (5 rows: dangerous with a paid click, trusted anonymous, VPN with a local network leak and negative signals, the 999 rate-limit marker, a search bot) |
| `normalization-cases.json` | History rows and webhook `data` objects with the exact normalized `Identification` |
| `risk-band-cases.json` | Score to band |
| `webhook-identification-scored.json`, `.raw.txt` | Scored event (pretty, and the compact bytes as sent) |
| `webhook-rate-limited.json` | Scored event carrying the 999 marker |
| `webhook-ping.json`, `.raw.txt` | Verify ping, exact bytes |
| `webhook-test-delivery.json` | Test delivery from the analytics dashboard: 17 of 19 flags, second-precision timestamps |
| `webhook-signature-vectors.json` | Signature vectors (`secret` or a `secrets` list) |
| `management-profile.json`, `management-profile-expected.json` | Management API profile body and the normalized domain profile |
| `error-responses.json` | Error bodies per API and status, with the expected error class |
