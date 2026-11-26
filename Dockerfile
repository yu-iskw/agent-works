# Production images for the aw-api and aw-web Cloud Run services:
#   docker build --platform linux/amd64 --target api -t aw-api .
#   docker build --platform linux/amd64 --target web -t aw-web .
# The build stage compiles both apps. Each runtime stage holds only its app's `pnpm deploy --prod`
# output, owned by root and run as `node`. Configuration and secrets arrive from Cloud Run at run
# time; Cloud Run sets PORT and both servers default to 8080.
FROM node:24.13.0-bookworm-slim AS build
RUN npm install --global pnpm@11.0.5
ENV CI=true
WORKDIR /repo
COPY . .
# Deploy copies workspace dependencies into /out (inject-workspace-packages), so the runtime stage
# needs no repo. `--legacy` would symlink them back into /repo instead. The setting is passed here
# only, because putting it in pnpm-workspace.yaml rewrites the lockfile.
RUN pnpm install --frozen-lockfile --filter @agent-works/api... --filter @agent-works/web... \
  && pnpm --filter @agent-works/api... --filter @agent-works/web... build \
  && pnpm --config.inject-workspace-packages=true --filter @agent-works/api --prod deploy /out/api \
  && pnpm --config.inject-workspace-packages=true --filter @agent-works/web --prod deploy /out/web

FROM node:24.13.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
EXPOSE 8080
HEALTHCHECK NONE

FROM runtime AS api
COPY --from=build /out/api .
CMD ["node", "dist/server.js"]

FROM runtime AS web
COPY --from=build /out/web .
CMD ["node", "dist/src/server.js"]
