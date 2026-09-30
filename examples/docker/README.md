# Docker

The image `ghcr.io/shieldlabs-ai/shieldlabs-mcp` runs the server as an unprivileged user and
speaks stdio by default, so MCP clients can start it with `docker run -i`
(see [`claude_desktop_config.json`](claude_desktop_config.json)):

```bash
docker run --rm -i -e SHIELDLABS_API_KEY ghcr.io/shieldlabs-ai/shieldlabs-mcp:1.0.0
```

Streamable HTTP inside a container must bind to all interfaces of the container:

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e SHIELDLABS_API_KEY -e SHIELDLABS_MCP_TOKEN \
  ghcr.io/shieldlabs-ai/shieldlabs-mcp:1.0.0 --transport http --host 0.0.0.0 --port 8787
```

Publishing the port on `127.0.0.1` only keeps the endpoint local to the host.
