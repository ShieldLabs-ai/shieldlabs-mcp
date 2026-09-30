# Streamable HTTP

Run the server as a local HTTP endpoint when a client cannot start processes, or to share one
server between several clients on the same machine:

```bash
export SHIELDLABS_API_KEY=sec_your_private_key
export SHIELDLABS_MCP_TOKEN="$(openssl rand -hex 32)"
npx -y @shieldlabs/mcp --transport http --port 8787
```

- The endpoint is `http://127.0.0.1:8787/mcp`. Every request needs
  `Authorization: Bearer $SHIELDLABS_MCP_TOKEN`; without the variable, the server generates a
  token and prints it once to stderr.
- Requests that carry an `Origin` header are refused unless the origin is listed with
  `--allowed-origins https://app.example.com`. On a loopback address, requests addressed to other
  host names are refused as well.
- `GET /health` answers `{"status":"ok"}` without authentication and without data.
- The server is stateless: each POST is handled on its own, with JSON responses.
- Every client of the server shares one History API budget (2 requests in flight, 5 per second),
  and the `integrate_shieldlabs` prompt uses its built-in guide: over HTTP the server fetches no
  remote content.

Try it with curl:

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $SHIELDLABS_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Binding to another address (`--host 0.0.0.0`) exposes the endpoint to the network: keep the token
secret and put TLS in front of the server.
