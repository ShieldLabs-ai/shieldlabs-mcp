# Claude Desktop

Open **Settings > Developer > Edit Config** and merge
[`claude_desktop_config.json`](claude_desktop_config.json) into the file that opens
(`claude_desktop_config.json`). Replace `sec_your_private_key` with the Private API Key of your
domain from the analytics dashboard (https://app.shieldlabs.ai), then restart Claude Desktop.

Optional variables, all in the same `env` object:

- `SHIELDLABS_SECRET_KEY` and `SHIELDLABS_DOMAIN`: enable `shieldlabs_get_domain_profile`.
- `SHIELDLABS_WEBHOOK_SECRET`: default secret for `shieldlabs_verify_webhook_signature` (several
  separated by commas while you rotate).

Without `SHIELDLABS_API_KEY` the server starts with the offline tools only.
