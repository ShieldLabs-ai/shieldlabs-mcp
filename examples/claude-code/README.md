# Claude Code

Add the server for your user, so it is available in every project:

```bash
claude mcp add --transport stdio --scope user shieldlabs --env SHIELDLABS_API_KEY=sec_your_private_key -- npx -y @shieldlabs-ai/mcp
```

Without `--scope user` the command adds it for the current project only (local scope).

Or share it with a project: copy [`.mcp.json`](.mcp.json) to the project root. It reads
`SHIELDLABS_API_KEY` from the environment of each developer (`${SHIELDLABS_API_KEY}`), so the key
never lands in the repository.

Over HTTP (see [`../http`](../http)):

```bash
claude mcp add --transport http shieldlabs http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $SHIELDLABS_MCP_TOKEN"
```

Check the connection with `claude mcp list`, then ask for example: "Review the ShieldLabs request
02f1d973-84db-4156-a7f7-e799e6bf389b" or run the prompt `/mcp__shieldlabs__review_request`.
