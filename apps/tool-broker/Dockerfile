# Production image for aw-tool-broker (Cloud Run, internal ingress, invoked only by the API and workflow identities).
# Build from the repository root:
#   docker build -f apps/tool-broker/Dockerfile -t aw-tool-broker:local .
# Node and pnpm pins follow .node-version and package.json packageManager.

FROM node:24.13.0-bookworm-slim AS build
RUN npm install --global pnpm@11.0.5 && npm cache clean --force
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @agent-works/tool-broker run build \
  && pnpm --filter @agent-works/tool-broker deploy --legacy --prod /out

FROM node:24.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# Any HTTP response (including 404) proves the server is listening. Cloud Run uses its own probes.
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(()=>process.exit(0),()=>process.exit(1))"
# Cloud Run injects PORT (8080); server.ts reads it from the environment.
CMD ["node", "dist/server.js"]
