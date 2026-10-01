# ShieldLabs MCP server image: stdio by default, streamable HTTP with --transport http.
#
# Build dist/ first (npm run build). The bundle already contains @shieldlabs-ai/node, so the image
# installs only the runtime dependencies of this package.
#
#   docker build -t ghcr.io/shieldlabs-ai/shieldlabs-mcp:1.0.0 .
#   docker run --rm -i -e SHIELDLABS_API_KEY ghcr.io/shieldlabs-ai/shieldlabs-mcp:1.0.0
FROM node:20-alpine

LABEL org.opencontainers.image.title="shieldlabs-mcp" \
      org.opencontainers.image.description="MCP server for ShieldLabs identifications, history, Risk Scores and webhooks" \
      org.opencontainers.image.source="https://github.com/ShieldLabs-ai/shieldlabs-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.shieldlabs-ai/shieldlabs-mcp"

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY dist ./dist

# Runs as the unprivileged "node" user of the base image.
USER node

# Only used with --transport http --host 0.0.0.0.
EXPOSE 8787

ENTRYPOINT ["node", "/app/dist/index.js"]
