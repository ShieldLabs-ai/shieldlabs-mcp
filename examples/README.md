# Client configuration examples

| Folder | Client |
|---|---|
| [`hosted`](hosted) | The hosted server at `https://mcp.shieldlabs.ai/mcp`: sign in, nothing to run |
| [`claude-desktop`](claude-desktop) | Claude Desktop (`claude_desktop_config.json`) |
| [`claude-code`](claude-code) | Claude Code (`claude mcp add`, project `.mcp.json`) |
| [`grok`](grok) | Grok (`grok mcp add`, `~/.grok/config.toml`) |
| [`cursor`](cursor) | Cursor (`.cursor/mcp.json`) |
| [`vscode`](vscode) | VS Code (`.vscode/mcp.json` with a secure key prompt) |
| [`http`](http) | Streamable HTTP with a bearer token, for clients that connect by URL |
| [`docker`](docker) | The container image, over stdio or HTTP |

All examples use placeholder keys: replace `sec_your_private_key` with the Private API Key of your
domain from the analytics dashboard (https://app.shieldlabs.ai).
