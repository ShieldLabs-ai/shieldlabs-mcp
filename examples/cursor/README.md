# Cursor

Copy [`mcp.json`](mcp.json) to `.cursor/mcp.json` in your project (or to `~/.cursor/mcp.json` for
every project) and replace `sec_your_private_key` with the Private API Key of your domain. Enable
the server under **Settings > MCP**.

To connect to a server started with `--transport http` instead:

```json
{
  "mcpServers": {
    "shieldlabs": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <SHIELDLABS_MCP_TOKEN>" }
    }
  }
}
```

Keep files that contain keys out of version control.
