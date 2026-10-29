# Toolbox for building and testing inside Linux: the dev image plus the Postgres 16 binaries
# that apps/api/src/ledger/disposable-postgres.ts expects, as on GitHub's Ubuntu runners.
FROM aw-dev-node:local

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg git \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-16 \
  && apt-get clean
USER node
HEALTHCHECK NONE
