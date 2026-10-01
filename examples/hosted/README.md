# Hosted server

ShieldLabs runs the server at `https://mcp.shieldlabs.ai/mcp`. Clients connect by URL and sign in
with a ShieldLabs account; the client refreshes its access by itself. No key is written in these
files, so they can be committed.

| File | Client |
|---|---|
| [`.mcp.json`](.mcp.json) | Claude Code, project scope: copy it to the project root, then run `/mcp` and choose Authenticate |
| [`cursor-mcp.json`](cursor-mcp.json) | Cursor: copy it to `.cursor/mcp.json` and sign in when Cursor asks |
| [`vscode-mcp.json`](vscode-mcp.json) | VS Code: copy it to `.vscode/mcp.json`, start the server from **MCP: List Servers** and sign in |

In Claude, add a custom connector with the same URL under **Customize > Connectors**. With Claude
Code, `claude mcp add --transport http shieldlabs https://mcp.shieldlabs.ai/mcp` does the same as
the project file for your user.

In this release the hosted server offers one tool, `shieldlabs_check_connection`, which confirms
that the sign-in works. The tools that read identifications follow in a later release; until then,
run the local server (`npx -y @shieldlabs-ai/mcp`) with the Private API Key of your domain. The
hosted server does not accept API keys yet: sign-in is the only way in.
