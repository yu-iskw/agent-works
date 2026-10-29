# P0 baseline

Captured 2026-10-29 on branch `yu-iskw/p0-workbench` at `0e2d565`, clean tree.

## Toolchain

| Item           | Observed                                              | Expected                  |
| -------------- | ----------------------------------------------------- | ------------------------- |
| Node           | v26.12.1 (host)                                       | 24.13.0 (`.node-version`) |
| pnpm           | 11.0.5                                                | 11.0.5 (`packageManager`) |
| Docker         | `/Users/yu/.rd/docker` (Rancher Desktop)              | Compose v2                |
| gcloud         | `/opt/homebrew/bin/gcloud`, project `ubie-yu-sandbox` | ADC present               |
| Local Postgres | none on host (tests use Compose Postgres)             |                           |

## Existing system (reuse candidates)

- `apps/api` (~RFC-001 `bff`): route table in `apps/api/src/routes/index.ts`.
  Existing endpoints include `POST /v1/ask`, task submit/read/events/cancel slots
  (`routes/tasks*.ts`), approvals read/decide (`routes/approvals*.ts`), artifacts read,
  OAuth connections read, schedules, admin, governance, memory, analytics.
- Persistence: Postgres migrations `apps/api/migrations/0001`–`0016`, including
  `0006_tasks.sql`, `0008_task_history.sql`, `0003_approvals.sql`,
  `0009_approval_payload.sql`. Ledger in `apps/api/src/ledger/postgres-ledger.ts`.
- Auth: fake IAP JWT verification in `apps/api/src/auth/iap.ts`, fake IAP proxy in
  `packages/fakes`. Users `alice` / `bob` via header `x-fake-user`.
- Retrieval: Drive adapter `apps/api/src/retrieval/drive-adapter.ts`, HTTP Drive
  `retrieval/http-drive.ts`.
- Agent: `apps/api/src/agent/adk-runner.ts` (ADK-JS) and `scripted-runner.ts`.
- Web: server-rendered TS (`apps/web/app/*`, `apps/web/src/server.ts`) with pages for
  admin, approvals, citations, connections, memory, schedules. CSRF helpers exist in
  `apps/web/app/{admin,memory,schedules}/csrf.ts`.
- Compose: `compose.yaml` (ADC-mounted dev stack with fakes, read-only gcloud bind
  mount at `/gcloud`) and `compose.dev.yml` (fake-only CI e2e stack).
- E2E: `e2e/` with Playwright configs, contract, security, adversarial and web suites.

Deeper mapping of task events, owner scoping and approvals is pending; it needs the
build to run (see blockers).

## Verified commands

| Command                                                                                       | Result                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git status`                                                                                  | clean                                                                                                                                                                                                                                               |
| `pnpm test`                                                                                   | **FAIL** before any test runs: `tsc` in `packages/domain` reports `TS6053 File '.../packages/domain/src/credentials.ts' not found`. The agent sandbox denies reads of `./**/credentials*`, so the compiler cannot open the file. Not a repo defect. |
| `docker info`                                                                                 | **FAIL**: `permission denied while trying to connect to the docker API at unix:///Users/yu/.rd/docker.sock` (agent sandbox).                                                                                                                        |
| bind `127.0.0.1:0` from Node                                                                  | **FAIL**: `EPERM` (agent sandbox blocks local port binding).                                                                                                                                                                                        |
| ADC token + `GET aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-3.8-flash` | **FAIL**: sandbox network proxy denies `oauth2.googleapis.com:443` and `aiplatform.googleapis.com:443`. Model ID not yet discovered.                                                                                                                |
| `git ls-remote origin main`                                                                   | OK                                                                                                                                                                                                                                                  |
| `gh auth status`                                                                              | **FAIL**: sandbox denies reading `~/.config/gh/config.yml`.                                                                                                                                                                                         |
