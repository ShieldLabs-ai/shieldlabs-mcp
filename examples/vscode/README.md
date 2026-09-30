# VS Code

Copy [`mcp.json`](mcp.json) to `.vscode/mcp.json` in your workspace. VS Code asks for the Private
API Key the first time the server starts and stores it securely, so the file holds no secret and
can be committed. Start the server from the **MCP: List Servers** command, then use it in Copilot
Chat agent mode.

To connect to a server started with `--transport http` instead:

```json
{
  "servers": {
    "shieldlabs": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${input:shieldlabs-mcp-token}" }
    }
  },
  "inputs": [
    { "type": "promptString", "id": "shieldlabs-mcp-token", "description": "SHIELDLABS_MCP_TOKEN", "password": true }
  ]
}
```
