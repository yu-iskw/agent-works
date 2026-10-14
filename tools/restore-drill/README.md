# Disposable restore and DLQ tools

Build with `pnpm build` before running the `.mjs` entry points. `run.mjs` allocates its
own Postgres, performs an actual SQL dump/restore and verifies external create counts.
It does not accept a live database URL. Docker is never pruned.

```bash
node tools/restore-drill/run.mjs tools/restore-drill/fixtures/request.json
```

`dlq.mjs` is the offline driver used by `aw dlq`. It requires a fixture JSON file with
a local `databaseUrl` for an already initialized disposable test database containing
`issue135_disposable_marker = OFFLINE_FIXTURE_ONLY`. See the stuck-task runbook for
operator fields. The marker is an accidental-use guard, not production authorization.

No deletion, dev hard stop or real restore is authorized (D-08, D-10, ADR 0003).
All limits, amounts, targets, retention and destinations are **PLACEHOLDERS**.
The test harness removes only the disposable instance it allocated.
