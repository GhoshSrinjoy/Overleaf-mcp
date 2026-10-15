# Build the self-contained MCP server bundle.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json esbuild.mjs ./
COPY src ./src
RUN node esbuild.mjs --production --server

# Runtime: Node plus git (Git-token projects) and ripgrep (fast search). No Redis needed.
FROM node:22-alpine
RUN apk add --no-cache git ripgrep
WORKDIR /app
COPY --from=build /src/dist/mcp-server.js ./mcp-server.js
ENV NODE_ENV=production \
    OVERLEAF_MCP_HOME=/data
VOLUME /data
ENTRYPOINT ["node", "/app/mcp-server.js"]
