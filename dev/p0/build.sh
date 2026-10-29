#!/bin/sh
# Builds the checkout mounted at /src into /app (the p0-app volume). Skips all work when the
# sources are unchanged, so `docker compose up` stays fast and never rewrites files under
# running services.
set -eu
paths='package.json pnpm-lock.yaml pnpm-workspace.yaml apps packages agents/skills contracts schemas fixtures dev/p0'
filters="--filter @agent-works/api... --filter @agent-works/web... --filter @agent-works/fakes..."
snapshot() {
  # shellcheck disable=SC2086
  tar -C /src --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' -cf - $paths
}
hash=$(snapshot | sha256sum | cut -d' ' -f1)
if [ -f /app/.source-hash ] && [ "$(cat /app/.source-hash)" = "$hash" ]; then
  echo "p0 build up to date ($hash)"
  exit 0
fi
find /app -mindepth 1 -maxdepth 1 -exec rm -rf {} +
snapshot | tar -C /app -xmf - --no-same-owner --no-same-permissions --no-overwrite-dir
# shellcheck disable=SC2086
pnpm install --frozen-lockfile $filters
# shellcheck disable=SC2086
pnpm $filters build
echo "$hash" > /app/.source-hash
echo "p0 build complete ($hash)"
