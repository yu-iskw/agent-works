FROM node:24.13.0-bookworm-slim

# nodemon polls (-L) because inotify events do not cross the host-to-VM bind mount
# on macOS and Windows, so `node --watch` would never fire.
RUN npm install --global pnpm@11.0.5 nodemon@3.1.10 \
  && npm cache clean --force

# The container runs as the host UID (compose `user:`), which has no passwd entry
# here. Pre-create world-writable directories so named volumes mounted on them
# are writable by any UID.
RUN mkdir -p /home/dev /pnpm-store \
    /workspace/node_modules \
    /workspace/apps/api/node_modules \
    /workspace/apps/web/node_modules \
    /workspace/packages/api-contract/node_modules \
    /workspace/packages/cli/node_modules \
    /workspace/packages/common/node_modules \
    /workspace/packages/domain/node_modules \
    /workspace/packages/fakes/node_modules \
    /workspace/packages/policy/node_modules \
    /workspace/agents/skills/incident-analysis/node_modules \
  && chmod -R 0777 /home/dev /pnpm-store /workspace

WORKDIR /workspace

USER node

HEALTHCHECK NONE
