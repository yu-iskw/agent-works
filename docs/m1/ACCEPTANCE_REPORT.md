# M1 acceptance report

Status: **incomplete.** M1 is done only when M0 to M21 all pass. The gates that need Yu's setup (real OAuth members, live Drive, Docs, BigQuery and GitHub resources) and human reviewers are still BLOCKED or PENDING. Every other gate has local evidence on the real model.

Date: 2026-10-30. Branch `yu-iskw/m1-teammates`, checkpoint 2 on top of `348172f` (draft PR <https://github.com/yu-iskw/agent-works/pull/178>). Environment: macOS host, Rancher Desktop, Node 24.13.0 and pnpm 11 inside containers, Playwright 1.63 image, Vertex AI project `ubie-yu-sandbox`, location `global`, model `gemini-3.8-flash`.

The day-to-day ledger with owners and remaining work is in `docs/m1/PROGRESS.md`. This report records the evidence and what it does and does not prove.

## Live versus injected evidence

| Part         | Local-test stack (`aw-m1-local`, port 8281)                                                                                                      | Live stack (`aw-m1`, port 8280)                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Model        | Real Vertex `gemini-3.8-flash`, counted against the cap                                                                                          | Real Vertex, smoke only so far                         |
| Identity     | Labelled local-test members (`local-test:*` subjects, separate issuer that the live API rejects)                                                 | Real Google OAuth: **not yet run**                     |
| Sources      | Fixture files from `fixtures/m1/`, every item labelled `FIXTURE (local seed file, not a live service)`, plus deliberate faults for failure tests | Live Drive, Docs, BigQuery and GitHub: **not yet run** |
| Docs publish | Fixture document store, labelled "not Google Docs"                                                                                               | Real Google Docs: **not yet run**                      |

The UX review stack (`aw-m1-ux`, port 8282) uses a labelled scripted model that refuses to start with a real identity or live sources. It spends no Vertex calls, and nothing from it counts as acceptance evidence for model output.

## Ledger

| ID  | Criterion                                                       | Status                       | Evidence                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Baseline and reuse plan; unrelated work preserved               | PASS                         | `docs/m1/BASELINE.md`                                                                                                                                                                                                                 |
| M1  | Both segment stacks build, migrate, become ready, stop, restart | PASS (local-test stack)      | `pnpm m1:up:local`, `pnpm m1:restart` (`results-restart-*.json`). The live stack waits for `m1.env`.                                                                                                                                  |
| M2  | Requested model verified from runtime, no fallback              | PASS (smoke)                 | Smoke from both segment API containers returned `gemini-3.8-flash`; every ledger row records the served model, and the gate refuses another version                                                                                   |
| M3  | Two real members authenticate                                   | BLOCKED                      | Needs the OAuth client in `docs/m1/SETUP_OAUTH.md`                                                                                                                                                                                    |
| M4  | Segment isolation                                               | PASS (local)                 | `isolation.spec.ts` (other member, other segment, forged and missing assertions, CSRF, escaping)                                                                                                                                      |
| M5  | Templates, skills, private customization                        | PASS (local)                 | `catalog.spec.ts`                                                                                                                                                                                                                     |
| M6  | Export privacy, recipient-owned import                          | PASS (local)                 | `catalog.spec.ts` canaries; portable scanner unit tests                                                                                                                                                                               |
| M7  | Conversations, discussion, revisions, inbox agree               | PASS (local)                 | `conversation.spec.ts`, `coordinated.spec.ts`, restart suite                                                                                                                                                                          |
| M8  | Parallel manual assignments                                     | PENDING (local PASS)         | `manual-research.spec.ts` overlap on the real model; live overlap records still needed                                                                                                                                                |
| M9  | Real-model plans, no dispatch before version-bound approval     | PASS (local)                 | `coordinated.spec.ts`, `failures.spec.ts`, digest unit tests                                                                                                                                                                          |
| M10 | Three workflows in both segments, live                          | BLOCKED                      | Local real-model runs of all three workflows pass; live needs `docs/m1/SETUP_RESOURCES.md`                                                                                                                                            |
| M11 | Claims, numbers, freshness, uncertainty                         | PENDING (local PASS)         | `workflows.spec.ts` matches every comparison against `fixtures/m1/expected/*` within tolerance; claim-support unit tests                                                                                                              |
| M12 | Consequential actions bound and not duplicated                  | BLOCKED                      | Local: exact-revision approval, stale and replay refusal, reconcile, publish once. A real Docs write needs OAuth.                                                                                                                     |
| M13 | Failure paths recoverable and honest                            | PASS (local)                 | `failures.spec.ts`, refused repository, restart suite                                                                                                                                                                                 |
| M14 | Build, lint, type, security, unit, P0 regressions               | PASS (checkpoint 2, toolbox) | See Verification below; the Mac-only checks (Trunk, `lint:security`, knip) are rerun by Orca Conductor at each checkpoint                                                                                                             |
| M15 | Critical E2E with retries disabled; live counted separately     | PENDING (local PASS)         | `results-local.json`; the live suite has not run and is not counted                                                                                                                                                                   |
| M16 | Responsive, keyboard, accessibility                             | PASS (local)                 | axe 0 critical or serious on 7 pages at 375, 768 and 1440 px; keyboard tests; overflow assertions on 24 screens at three widths                                                                                                       |
| M17 | Visual inspection, reviewed baselines, comparison               | PENDING                      | 8 inspected rounds in `docs/m1/UX_ITERATIONS.md`; Yu has not yet reviewed baselines                                                                                                                                                   |
| M18 | Three live videos                                               | PENDING                      | Needs M10. Local real-model videos exist under `artifacts/m1/videos/local/` but are not live.                                                                                                                                         |
| M19 | Human usability gate                                            | PENDING                      | `docs/m1/UX_REVIEW.md`; no reviewers yet                                                                                                                                                                                              |
| M20 | Credentials, permissions, budgets, audit                        | PENDING (local PASS)         | ADC is mounted read-only into the two segment API containers only; no credential files in the `aw-m1:local` image; 0 token-pattern hits in service logs; sealed tokens; durable call caps; `tw_audit`. Repeat with real OAuth tokens. |
| M21 | Reproducible setup, evidence, verification                      | PENDING                      | `docs/m1/README.md`, `m1.env.example`, this report; the final `pnpm m1:verify` runs after the live gates                                                                                                                              |

## Six-journey matrix

| Workflow                        | alpha                                                                      | beta         |
| ------------------------------- | -------------------------------------------------------------------------- | ------------ |
| Research to decision brief      | Local PASS (manual and coordinated); live not run                          | Live not run |
| Metrics to explanation          | Local PASS (manifest match by region and by channel); live not run         | Live not run |
| Engineering request to proposal | Local PASS (question answered, revision, refused repository); live not run | Live not run |

The live suite (`e2e/m1/live/journeys.spec.ts`, `pnpm m1:e2e:live`) is written for all six and has never run.

## Verification (checkpoint 2)

All commands ran after `/code-review` and `/simplify`, on 2026-10-29 between 19:25 and 19:45 UTC.

| Command                                                                         | Result                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm m1:test` (toolbox: install, build, typecheck, `lint:eslint`, `pnpm test`) | all PASS; 271 test files passed, 4 skipped; 3191 tests passed, 98 skipped (pre-existing skips outside M1) |
| `pnpm m1:e2e:local` (real model, fixture sources, `retries: 0`)                 | 18 passed, 0 failed, 0 flaky, 0 skipped, 5.5 min (`artifacts/m1/results-local.json`)                      |
| `pnpm m1:restart`                                                               | before 1/1, after 1/1: an assignment killed mid-run and a full restart finish once, with no duplicates    |
| `pnpm m1:ux 9` and `pnpm m1:ux 10` (scripted model)                             | tour passes; no horizontal overflow on 24 screens at 375, 768 and 1440 px                                 |
| Credential checks                                                               | `docker inspect` mounts, an image file search and a log pattern scan (see M20)                            |

Not run in the sandbox: Trunk (`pnpm lint`), `pnpm lint:security` and `pnpm knip`. Orca Conductor runs them on Yu's Mac, and they passed at checkpoint 1.

## Model usage

Real Vertex calls so far: **105 of 600**, recounted from the four durable ledgers on 2026-10-30. Live `aw-m1`: alpha 4 of 200, beta 1 of 200 (smoke and the first runs). Local-test `aw-m1-local`: alpha 59 of 100, beta 41 of 100. The scripted review stack made no Vertex calls. Every real call row records the requested and served model (`gemini-3.8-flash`).

## Limitations

- No live provider has been exercised yet: Google sign-in, Drive, Docs, BigQuery and GitHub run only as code and unit tests until Yu's setup exists.
- The source check reads a fixed sample (the September to October 2026 comparison and a fixed keyword query). A source that answers but has nothing for that sample shows "Reachable, no data", not an error.
- knip, Trunk and `pnpm lint:security` cannot run in the agent sandbox. They run on Yu's Mac through Orca Conductor.
- UX rounds use a scripted model, so the statement text in those screenshots is canned. The real-model suites judge content.
- Screenshots, videos and traces stay local and gitignored under `artifacts/m1/`.
