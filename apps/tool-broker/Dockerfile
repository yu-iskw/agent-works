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
# Cloud Run injects PORT (8080); server.ts reads it from the environment.
CMD ["node", "dist/server.js"]
