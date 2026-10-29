# M1 progress

Source prompt: `/Users/yu/orca-prompts/agent-works-m1/prompt.md`, including Yu's binding decisions at the end. Resume from this file after compaction or restart.

## Binding operating rules (from Yu)

- Never commit or push. At each green checkpoint, stage everything except `.scratch/`, secrets, auth state and any media. Write `/Users/yu/orca-prompts/agent-works-m1/commit-msg.txt` (first checkpoint also writes `/Users/yu/orca-prompts/agent-works-m1/pr-body.md`, with the PR title on line 1), then print exactly `READY_TO_COMMIT`.
- Before each checkpoint, run `/code-review` then `/simplify` on the changed code. Fix P0 and P1 findings, plus worthwhile P2s, and rerun the affected gates.
- Asks go to Yu as one line starting `NEEDS_YU:`. Keep working on unblocked items.
- Vertex: project `ubie-yu-sandbox`, location `global`, model `gemini-3.8-flash`. **600 real calls total** across both segments (300 per segment, enforced by each segment's durable ledger). Concurrency 2. Stop and print `NEEDS_YU:` near the cap.
- No cloud resource, IAM, Drive file, dataset or GitHub writes by the agent. No `gcloud auth login`. No terraform apply.
- Trunk cannot run in the sandbox, so run the underlying linters directly. Playwright runs in containers.

## Environment notes

- `docker` works with the default context (Rancher Desktop socket). The P0 stack from another checkout (`aw-p0`) is running in stub mode. M1 uses project `aw-m1` and port 8280, so the two never collide.
- Reading `**/credentials*` is denied in the agent shell. Do not name new files `credentials*`.

## Real Vertex call budget

Used by this campaign: **62 / 600** (2026-10-30, after the final local suite run). Ledgers: live `aw-m1` alpha 4/200, beta 1/200. Local-test `aw-m1-local` alpha 35/100, beta 22/100 (2 rows stay `pending` from the restart suite's deliberate kill; they still count). UX rounds 1-6 used the scripted model: 0 calls. The `aw-m1` volumes also hold my first local-test rows (owners `local-test:*`); they are kept because deleting them would reset the ledger.

| #   | When (UTC)             | Segment | Purpose                                                                                       | Result                                                                                                                     |
| --- | ---------------------- | ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-29 13:20:15    | alpha   | smoke (`teamwork/smoke.js` in `api-alpha`)                                                    | 200, `gemini-3.8-flash`, 2201 ms, `EEjjao8xr5690A-Y1o65AQ`                                                                 |
| 3-5 | 2026-10-29 13:40-13:41 | alpha   | manual research journey (fixture sources, local-test identity): 2 contributions + 1 synthesis | 200, 18.2 s / 23.0 s / 17.3 s                                                                                              |
| 2   | 2026-10-29 13:20:18    | beta    | smoke (`teamwork/smoke.js` in `api-beta`)                                                     | 200, `gemini-3.8-flash`, 2784 ms, `E0jjariZBN-Lx9gP_7y9kAQ`, finish `MAX_TOKENS` at a 64-token cap (thinking tokens count) |

(A smoke attempt in the running P0 container at 2026-10-29 was refused before any request because that stack is in stub mode. It spent no call.)

## External dependencies (asked of Yu)

| Ask                                                        | File                         | Status                                              |
| ---------------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| Google OAuth client, GitHub OAuth App, secrets file        | `docs/m1/SETUP_OAUTH.md`     | requested 2026-10-29                                |
| Drive folders, BigQuery datasets and grants, GitHub issues | `docs/m1/SETUP_RESOURCES.md` | requested 2026-10-29                                |
| Three usability reviewers                                  | `docs/m1/UX_REVIEW.md`       | requested 2026-10-29 (needs a runnable build first) |

## Acceptance ledger

Owner is the agent unless stated. Status values are PASS, FAIL, BLOCKED and PENDING.

| ID  | Criterion                                                                       | Owner      | Status               | Evidence                                                                                                                                               | Updated    | Remaining                                                        |
| --- | ------------------------------------------------------------------------------- | ---------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------- |
| M0  | Baseline and reuse plan recorded; unrelated work preserved                      | agent      | PASS                 | `docs/m1/BASELINE.md`; tree was clean at start                                                                                                         | 2026-10-29 | none                                                             |
| M1  | Both segment stacks build, migrate, become ready, stop, restart                 | agent      | PENDING              |                                                                                                                                                        |            | `compose.m1.yaml` not written                                    |
| M2  | Requested Gemini model verified from runtime, no fallback                       | agent      | PASS (smoke)         | `docker compose -f compose.m1.yaml run --rm --no-deps -T api-<seg> node apps/api/dist/teamwork/smoke.js`; budget rows above                            | 2026-10-29 | rerun in final `m1:verify`                                       |
| M3  | Two real members authenticate and use authorized access                         | agent + Yu | BLOCKED              |                                                                                                                                                        |            | OAuth client (SETUP_OAUTH)                                       |
| M4  | Two segment backends isolate data and pending responses                         | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M5  | Curated templates and skills, private customization and reuse                   | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M6  | Exports exclude credentials and private data; import uses recipient permissions | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M7  | Conversations, task discussion, revisions and inbox agree                       | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M8  | Manual assignments run in parallel within caps                                  | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M9  | Coordinator plans are real-model and version-bound before dispatch              | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M10 | Three workflows succeed in both segments                                        | agent + Yu | BLOCKED              |                                                                                                                                                        |            | live resources (SETUP_RESOURCES)                                 |
| M11 | Claims, numbers, freshness and uncertainty meet rubrics                         | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M12 | Consequential actions bind target, content and revision; no duplicates          | agent + Yu | BLOCKED              |                                                                                                                                                        |            | live Docs needs OAuth                                            |
| M13 | Failure paths recoverable and honest                                            | agent      | PASS (local)         | `failures.spec.ts`, missing-contribution and reconcile tests, restart suite                                                                            | 2026-10-30 | live provider errors                                             |
| M14 | Build, lint, type, security, unit, integration, P0 regressions pass             | agent + Yu | PENDING              | toolbox: `pnpm build`, `pnpm typecheck`, `pnpm lint:eslint` (0 problems), `pnpm test` 3189 passed; Mac (Yu): `pnpm lint` and `pnpm lint:security` pass | 2026-10-30 | Yu reruns `pnpm knip` on the Mac after the 8 findings were fixed |
| M15 | Critical E2E pass with retries disabled; live and CI status separate            | agent      | PENDING (local PASS) | `pnpm m1:e2e:local` 15/15 with `retries: 0`; `results-local.json`                                                                                      | 2026-10-30 | live suite                                                       |
| M16 | Responsive, keyboard and accessibility (zero critical or serious)               | agent      | PASS (local)         | `a11y.spec.ts` axe 0 critical/serious on 7 pages × 3 widths, keyboard menu and segment switch; tour overflow assertions 22 screens × 3 widths          | 2026-10-30 | human keyboard check during M19                                  |
| M17 | Visual inspection, reviewed baselines, later comparison passes                  | agent + Yu | PENDING              | 6 inspected UX rounds in `docs/m1/UX_ITERATIONS.md`                                                                                                    | 2026-10-30 | Yu reviews round-6 captures as baselines; later comparison       |
| M18 | Three real-model live videos, playable and sanitized                            | agent      | PENDING              |                                                                                                                                                        |            | needs M10                                                        |
| M19 | Human usability gate with real reviewers                                        | Yu         | PENDING              | `docs/m1/UX_REVIEW.md`                                                                                                                                 | 2026-10-29 | reviewers                                                        |
| M20 | Credential handling, permissions, budgets, audit                                | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |
| M21 | Setup, troubleshooting, evidence and verification reproducible                  | agent      | PENDING              |                                                                                                                                                        |            |                                                                  |

## Checkpoints

- [x] Read brief, repo instructions and `docs/p0/*`
- [x] Seed corpus and expected manifests (`fixtures/m1/`, `scripts/m1/seed-data.mjs`)
- [x] Setup checklists: `SETUP_OAUTH.md`, `SETUP_RESOURCES.md`, `UX_REVIEW.md`
- [x] Domain contracts `packages/domain/src/teamwork*.ts` (25 unit tests)
- [x] Migration `0018_teamwork.sql` (applied by both P0 and M1 runtimes) and P0 compatibility edits (`kind = 'flagship'` filters, partial unique index)
- [x] `compose.m1.yaml`, builder, two segment APIs and DBs, web DB, `scripts/m1/run.mjs` with every `m1:*` command
- [x] Live Vertex smoke from both segment APIs (M2)
- [x] Identity code: Google OIDC sign-in, sessions, ES256 member assertion, membership, gated e2e session (live run blocked on OAuth client)
- [x] Catalog, teammates, skills, customization, export and import
- [x] Conversations, tasks, plans, assignments, parallel worker, synthesis, revisions, inbox
- [x] Source adapters: Drive, Docs publish, BigQuery, GitHub (live, untested until resources exist), plus labelled fixtures
- [x] UI for every surface (first pass, inspected at 1440)
- [x] Integration tests with a scripted model port (9) and metric oracle tests (6); web tests (7)
- [x] First real-model local journey: manual research, two assignments overlapped (13:40:40 start, 13:40:59 and 13:41:03 finish)
- [x] ESLint clean repo-wide (delegate refactor, verified: build, typecheck, 3186 tests pass)
- [x] Local browser suites: 16/16 pass (coordinated plan to publish in 1.7 min, isolation, catalog, conversation, failures, a11y at 375/768/1440)
- [x] Restart suite: API killed mid-assignment plus full stop/start; task finished once, no duplicates (`pnpm m1:restart`)
- Fixed from browser runs: mobile menu focus (visibility transition blocked focus), evidence de-duplicated across assignments, titles up to 160 characters, one-time notices cleared from the URL
- [ ] Live suite (six journeys) once Yu's OAuth and resources exist
- [ ] Restart and worker-interruption suite, visual baselines, videos, evidence index
- [x] `/code-review high`: 10 findings, all fixed with regression tests (stuck cancel during synthesis; rerun deadline; replan leaves old assignments live; reply quarantine failed the task; cancel waits on reply jobs; plan `dependsOn` ignored; concurrent create 500; completed task reverted to ready; refresh tokens stored without e2e mode; multibyte compare crash)
- [x] UX loop (Yu, 2026-10-30): 5 recorded rounds on the scripted-model stack (`pnpm m1:ux <n>`), 19 defects fixed, log in `docs/m1/UX_ITERATIONS.md`
- [x] `/simplify` (4 reviewers): applied in two lanes (API delegate, web/domain by me); skips recorded in UX_ITERATIONS.md and below
- [x] Rerun on the post-simplify tree: local suites 15/15, restart, UX round 6; checkpoint 1 READY_TO_COMMIT (2026-10-30)

## Decisions

- Yu, 2026-10-29: APPROVED the read-only GitHub OAuth App and the secret-gated `POST /internal/e2e/session`. The endpoint is served only by `web`'s internal listener (port 8081, never published, so only loopback and the Compose network reach it). It requires `AW_M1_E2E_MODE=1` **and** `AW_M1_E2E_SESSION_SECRET`, and returns 404 otherwise, so it fails closed. A unit test proves it is disabled by default. Yu does the OAuth, resource and GitHub setup and fills `~/.config/agent-works-m1/m1.env`.

- One web BFF, two segment APIs, three Postgres services (`pg-web`, `pg-alpha`, `pg-beta`). Separate databases and volumes are simpler to prove isolated than roles on one server.
- Secrets and resource IDs are read from `~/.config/agent-works-m1/m1.env`, mounted read-only into the services. The docker CLI never reads it and the agent never opens it.
- The Docs publish target is the approving member's My Drive root, through `drive.file`. Reconcile uses Drive `appProperties`, a provider-side marker, not only a local idempotency key.
- Concurrency 2 applies per segment worker. Live acceptance runs segments one after another, so at most two real model calls are in flight.
- Subagent models: the repo's Grok role sheet cannot be selected in Claude Code, and AGENTS.md forbids Sonnet and Opus. Work stays in the main session.

## Next steps

1. Merge the lint delegate's refactor, rerun the toolbox gates and the 47 M1 tests.
2. `pnpm m1:up:local`, then run the local browser suites, fix the defects found, and inspect the screenshots.
3. Write the restart suite and the live suite (`e2e/m1/live/`), plus an internal e2e member-list endpoint.
4. `/code-review`, `/simplify`, then the first READY_TO_COMMIT.

## Lessons

- 2026-10-30: I edited `0018_teamwork.sql` after the local databases had applied it, so `depends_on` existed only on the newest stack and task creation failed with a `PostgresError` on the older ones. The UX stack was fresh, so the UX rounds passed while the local suites failed. Fix: the column moved to an idempotent `0019`. Rule, now in `apps/api/migrations/README.md`: never edit a migration any database has applied.

## Environment blocks (not product defects)

- Trunk (`pnpm lint`) and `pnpm lint:security`: they cannot run in the sandbox, so Yu ran them on the Mac (2026-10-30), and both **pass**. Trunk's autoformatting (`trunk check -y`) is kept, including the fixture Markdown and the expected-answer JSON.
- `pnpm knip` crashes in the sandbox's toolbox container, even with the unmodified HEAD `knip.json` (oxc-parser `RangeError: Array buffer allocation failed`). Yu's Mac run (2026-10-30) reported 4 unused exports and 4 unused exported types in M1 code, all fixed without ignores: `trackConsoleErrors` deleted; `SOURCE`, `ConversationPanel`, `SCREENSHOTS`, `OAuthClient`, `SourceMode`, `MetricRows` and `TaskError` made module-local. **Yu reruns `pnpm knip` on the Mac** to confirm.

## /simplify skips (with reasons)

- Job `subject_id` columns instead of string refs, and dropping `tw_conversations`: schema changes, better as their own reviewed step.
- Splitting `wb_tasks` into per-product tables: contradicts the one-task-system decision in BASELINE.md.
- Sharing P0's model gate, readiness and fixture-doc store with teamwork: changes P0 behavior; P0 regressions would need re-proof.
- LISTEN/NOTIFY instead of idle polling; JWT verifier sharing across apps; a page-shell module shared with P0 web: deferred.

## Decisions (later)

- Call caps are per ledger: live `aw-m1` 200 + 200 and local-test `aw-m1-local` 100 + 100, summing to 600. Local-test runs in its own Compose project and port (8281), so test identities never touch live volumes again.
