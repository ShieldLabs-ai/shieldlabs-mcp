# Grok

The local server reads the History API. The hosted server only confirms that sign-in works until
the account API serves history, domains and webhooks.

## Local server

Copy [`config.toml`](config.toml) into `~/.grok/config.toml`, or into `.grok/config.toml` in a
project. Export the Private API Key of the domain before you start Grok:

```bash
export SHIELDLABS_API_KEY=sec_your_private_key
```

Or add the server from a shell. The value is stored as written, so prefer the environment variable
over pasting the key into a file that is committed:

```bash
grok mcp add shieldlabs -e SHIELDLABS_API_KEY='${SHIELDLABS_API_KEY}' -- npx -y @shieldlabs-ai/mcp
```

Open `/mcps`, enable `shieldlabs`, and ask for example: "Review the ShieldLabs request
02f1d973-84db-4156-a7f7-e799e6bf389b".

## Hosted server

```toml
[mcp_servers.shieldlabs]
url = "https://mcp.shieldlabs.ai/mcp"
```

```bash
grok mcp add --transport http shieldlabs https://mcp.shieldlabs.ai/mcp
```

Sign in when Grok asks. The only tool in this release is `shieldlabs_check_connection`.

The skills and slash commands install from the plugin:

```bash
grok plugin marketplace add ShieldLabs-ai/shieldlabs-skills
grok plugin install shieldlabs --trust
```
