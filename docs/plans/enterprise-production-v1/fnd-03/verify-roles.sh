#!/usr/bin/env bash
# Applies migrations 0001..latest, roles.sql, grants.sql and verify-roles.sql to a DISPOSABLE local
# Postgres 16 container (tmpfs, loopback only). Never accepts a database URL: it cannot reach a
# real instance. Requires docker and the postgres:16-alpine image already present (no pull).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
name="fnd03-roles-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --pull=never -d --rm --name "$name" --tmpfs /var/lib/postgresql/data:rw,size=256m \
	-e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 40); do
	docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break
	sleep 0.5
done
# The image runs a temporary bootstrap server first; wait until a real query works twice.
for _ in $(seq 1 20); do
	docker exec "$name" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
	sleep 0.5
done
psql_in() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -q -U postgres "$@"; }

psql_in <"$here/roles.sql"
psql_in -c "create table schema_migrations (name text primary key, applied_at timestamptz not null default now())"
psql_in -c "alter table schema_migrations owner to aw_migrator"
for file in "$repo"/apps/api/migrations/0*.sql; do
	{
		echo "set role aw_migrator;"
		cat "$file"
	} | psql_in
done
psql_in <"$here/grants.sql"
# Re-running grants must be a no-op (idempotence).
psql_in <"$here/grants.sql"
psql_in <"$here/verify-roles.sql"
