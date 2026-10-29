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

Used by this campaign: **141 / 600** (2026-10-30, recounted from the four ledgers after the final `m1:verify`). Ledgers: live `aw-m1` alpha 4/200, beta 1/200. Local-test `aw-m1-local` alpha 79/100, beta 57/100. UX rounds 1-13 used the scripted model: 0 calls. Reallocating the per-ledger caps for the next milestone is Yu's decision.

| #   | When (UTC)             | Segment | Purpose                                                                                       | Result                                                                                                                     |
| --- | ---------------------- | ------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | 2026-10-29 13:20:15    | alpha   | smoke (`teamwork/smoke.js` in `api-alpha`)                                                    | 200, `gemini-3.8-flash`, 2201 ms, `EEjjao8xr5690A-Y1o65AQ`                                                                 |
| 3-5 | 2026-10-29 13:40-13:41 | alpha   | manual research journey (fixture sources, local-test identity): 2 contributions + 1 synthesis | 200, 18.2 s / 23.0 s / 17.3 s                                                                                              |
| 2   | 2026-10-29 13:20:18    | beta    | smoke (`teamwork/smoke.js` in `api-beta`)                                                     | 200, `gemini-3.8-flash`, 2784 ms, `E0jjariZBN-Lx9gP_7y9kAQ`, finish `MAX_TOKENS` at a 64-token cap (thinking tokens count) |

(A smoke attempt in the running P0 container at 2026-10-29 was refused before any request because that stack is in stub mode. It spent no call.)

## External dependencies (asked of Yu)

| Ask                                                        | File                         | Status                                |
| ---------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| Google OAuth client, GitHub OAuth App, secrets file        | `docs/m1/SETUP_OAUTH.md`     | withdrawn 2026-10-30: M1 is mock-only |
| Drive folders, BigQuery datasets and grants, GitHub issues | `docs/m1/SETUP_RESOURCES.md` | withdrawn 2026-10-30: M1 is mock-only |
| Three usability reviewers                                  | `docs/m1/UX_REVIEW.md`       | moved to the UI/UX milestone          |

## Acceptance ledger

Owner is the agent unless stated. Status values are PASS, FAIL, BLOCKED and PENDING.

| ID  | Criterion                                                                       | Owner        | Status                                       | Evidence                                                                                              | Updated    | Remaining                                |
| --- | ------------------------------------------------------------------------------- | ------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------- |
| M0  | Baseline and reuse plan recorded; unrelated work preserved                      | agent        | PASS                                         | `docs/m1/BASELINE.md`                                                                                 | 2026-10-29 | none                                     |
| M1  | Both segment stacks build, migrate, become ready, stop, restart                 | agent        | PASS                                         | `pnpm m1:up` (mock stack), `pnpm m1:restart`                                                          | 2026-10-30 | none                                     |
| M2  | Requested Gemini model verified from runtime, no fallback                       | agent        | PASS                                         | `doctor --vertex` inside `pnpm m1:verify`                                                             | 2026-10-30 | none                                     |
| M3  | Two members authenticate (mock, by Yu's decision)                               | agent        | PASS (mock)                                  | two mock members, `isolation.spec.ts`; no real sign-in claimed                                        | 2026-10-30 | real Google sign-in in a later milestone |
| M4  | Two segment backends isolate data and pending responses                         | agent        | PASS                                         | `isolation.spec.ts`                                                                                   | 2026-10-30 | none                                     |
| M5  | Curated templates and skills, private customization and reuse                   | agent        | PASS                                         | `catalog.spec.ts`                                                                                     | 2026-10-30 | none                                     |
| M6  | Exports exclude credentials and private data; import uses recipient permissions | agent        | PASS                                         | `catalog.spec.ts`, portable scanner tests                                                             | 2026-10-30 | none                                     |
| M7  | Conversations, task discussion, revisions and inbox agree                       | agent        | PASS                                         | `conversation.spec.ts`, `coordinated.spec.ts`, restart suite                                          | 2026-10-30 | none                                     |
| M8  | Manual assignments run in parallel within caps                                  | agent        | PASS                                         | `manual-research.spec.ts` overlap on the real model                                                   | 2026-10-30 | none                                     |
| M9  | Coordinator plans are real-model and version-bound before dispatch              | agent        | PASS                                         | `coordinated.spec.ts`, `failures.spec.ts`, digest tests                                               | 2026-10-30 | none                                     |
| M10 | Three workflows in both segments (fixture sources, real model)                  | agent        | PASS (fixture)                               | research, metrics and engineering journeys in both segments                                           | 2026-10-30 | live in a later milestone                |
| M11 | Claims, numbers, freshness, uncertainty (fixture)                               | agent        | PASS (fixture)                               | manifest match in `workflows.spec.ts`, claim-support tests                                            | 2026-10-30 | live data later                          |
| M12 | Consequential actions bind target, content and revision (fixture Docs)          | agent        | PASS (fixture)                               | exact-revision approval, refusal, reconcile, publish once                                             | 2026-10-30 | real Docs write later                    |
| M13 | Failure paths recoverable and honest                                            | agent        | PASS                                         | `failures.spec.ts`, refusal, restart suite                                                            | 2026-10-30 | none                                     |
| M14 | Build, lint, type, security, unit, integration, P0 regressions pass             | agent + Orca | PASS (toolbox); Mac checks pending           | `pnpm m1:verify` (toolbox gates); Mac: Trunk, `lint:security`, knip                                   | 2026-10-30 | Mac checks and CI for the final commit   |
| M15 | Critical E2E pass with retries disabled; live counted separately                | agent        | PASS (19/19)                                 | `results-local.json`; live suite out of scope                                                         | 2026-10-30 | none                                     |
| M16 | Responsive, keyboard and accessibility                                          | agent        | PASS                                         | axe at three widths, keyboard tests, mock labels at 375 px, overflow assertions                       | 2026-10-30 | none                                     |
| M17 | Visual baselines                                                                | Yu           | MOVED to the UI/UX milestone (Yu's decision) | 13 rounds in `UX_ITERATIONS.md`                                                                       | 2026-10-30 | `NEXT_MILESTONE.md`                      |
| M18 | Three real-model videos (fixture sources)                                       | agent        | PASS (fixture)                               | `artifacts/m1/videos/local/` (gitignored)                                                             | 2026-10-30 | live videos later                        |
| M19 | Human usability gate                                                            | Yu           | MOVED to the UI/UX milestone (Yu's decision) | `UX_REVIEW.md`                                                                                        | 2026-10-30 | `NEXT_MILESTONE.md`                      |
| M20 | Credential handling, permissions, budgets, audit (mock tokens)                  | agent        | PASS (mock)                                  | ADC mounts, no secrets mount on mock stacks, image and log scans, policy tests, call caps, `tw_audit` | 2026-10-30 | real tokens later                        |
| M21 | Setup, troubleshooting, evidence and verification reproducible                  | agent        | PASS                                         | `README.md`, `ACCEPTANCE_REPORT.md`, `pnpm m1:verify`, `pnpm m1:evidence`                             | 2026-10-30 | none                                     |

## Commits and PR

| Checkpoint | Commit                                                                   | PR                                                              | Notes                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | `348172f` (GPG-signed by Orca, includes Trunk's reformat of PROGRESS.md) | [#178](https://github.com/yu-iskw/agent-works/pull/178) (draft) | 19/19 CI checks pass; Mac `pnpm knip` and `pnpm lint` pass (run by Orca Conductor)                                                      |
| 2          | `fffa281`                                                                | [#178](https://github.com/yu-iskw/agent-works/pull/178) (draft) | CI failed on knip (exported `Metrics` type in `e2e/m1/helpers.ts`) and markdownlint MD034 (bare PR URLs); fixed in the follow-up commit |

Budget rule for the rest of the campaign: pause and print `NEEDS_YU:` at 550 of 600 real calls.

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
- [x] Checkpoint 2 work (2026-10-30): internal e2e member list for the live suite; `POST /v1/teamwork/sources/check` and a "Check live sources" control on Connections; repository allowlist enforced at task creation, with an inline field error; local-time `<time>` timestamps; real-model `workflows.spec.ts` (metrics manifest match, engineering question, revision and refused repository, setup check); UX rounds 7 to 10; `ACCEPTANCE_REPORT.md`
- [x] Checkpoint 2 `/code-review` (10 findings, all fixed: source check respects segment and member capabilities, isolates each source failure, reports "no data" apart from unreachable, shares one token per provider; unique live denial objective; region refresh no longer replaces every timestamped region; full repository allowlist in the hint; `role=status` moved off the list; `SourceCheck` shared from the domain; wrong e2e secrets on the members route are audited) and `/simplify` (4 reviewers, fixes applied; skips below); gates rerun: `pnpm m1:test` PASS, local suite 18/18, restart, UX rounds 9 and 10

## Decisions

- Yu, 2026-10-30 07:33 JST: M1 is **mock-only** apart from the real model (D1 = B). No real OAuth client, sign-in, Drive, Docs, BigQuery or GitHub; Yu does no setup. M3, M10, M11, M12, M18 and M20 are rescoped to mock or fixture evidence and never claimed as live. GitHub OAuth is out of scope and GitHub is mocked in tests; BigQuery uses fixtures only. M17 and M19 move to the next UI/UX milestone as its entry gates (D2). `pnpm m1:up` now starts the mock stack; the live stack stays behind `--live-stack` for later.
- Yu, 2026-10-29: APPROVED the read-only GitHub OAuth App and the secret-gated `POST /internal/e2e/session`. The endpoint is served only by `web`'s internal listener (port 8081, never published, so only loopback and the Compose network reach it). It requires `AW_M1_E2E_MODE=1` **and** `AW_M1_E2E_SESSION_SECRET`, and returns 404 otherwise, so it fails closed. A unit test proves it is disabled by default. Yu does the OAuth, resource and GitHub setup and fills `~/.config/agent-works-m1/m1.env`.

- One web BFF, two segment APIs, three Postgres services (`pg-web`, `pg-alpha`, `pg-beta`). Separate databases and volumes are simpler to prove isolated than roles on one server.
- Secrets and resource IDs are read from `~/.config/agent-works-m1/m1.env`, mounted read-only into the services. The docker CLI never reads it and the agent never opens it.
- The Docs publish target is the approving member's My Drive root, through `drive.file`. Reconcile uses Drive `appProperties`, a provider-side marker, not only a local idempotency key.
- Concurrency 2 applies per segment worker. Live acceptance runs segments one after another, so at most two real model calls are in flight.
- Subagent models: the repo's Grok role sheet cannot be selected in Claude Code, and AGENTS.md forbids Sonnet and Opus. Work stays in the main session.

## Next steps

1. Close M1: final `/code-review` and `/simplify` over the whole branch, `pnpm m1:verify`, `pnpm m1:evidence`, READY_TO_COMMIT.
2. Next milestone (UI/UX): `docs/m1/NEXT_MILESTONE.md`.

## Lessons

- 2026-10-30: the Vertex smoke's 64-token cap failed `m1:verify` with `empty_response`, because Gemini 3.8 spends thinking tokens against the cap. The same cause showed up in the first smoke on 2026-10-29 as `MAX_TOKENS`. Rule: no Gemini 3.8 call gets fewer than 1024 output tokens.

- 2026-10-30: I edited `0018_teamwork.sql` after the local databases had applied it, so `depends_on` existed only on the newest stack and task creation failed with a `PostgresError` on the older ones. The UX stack was fresh, so the UX rounds passed while the local suites failed. Fix: the column moved to an idempotent `0019`. Rule, now in `apps/api/migrations/README.md`: never edit a migration any database has applied.

## Environment blocks (not product defects)

- Trunk (`pnpm lint`) and `pnpm lint:security`: they cannot run in the sandbox, so Orca Conductor ran them on Yu's Mac (2026-10-30), and both **pass**. Trunk's autoformatting (`trunk check -y`) is kept, including the fixture Markdown and the expected-answer JSON.
- `pnpm knip` crashes in the sandbox's toolbox container, even with the unmodified HEAD `knip.json` (oxc-parser `RangeError: Array buffer allocation failed`). Orca Conductor's run on Yu's Mac (2026-10-30) reported 4 unused exports and 4 unused exported types in M1 code, all fixed without ignores: `trackConsoleErrors` deleted; `SOURCE`, `ConversationPanel`, `SCREENSHOTS`, `OAuthClient`, `SourceMode`, `MetricRows` and `TaskError` made module-local. Orca Conductor's rerun on Yu's Mac then **passed** (exit 0), and `pnpm lint` passed again.

## /simplify skips (with reasons)

- Job `subject_id` columns instead of string refs, and dropping `tw_conversations`: schema changes, better as their own reviewed step.
- Splitting `wb_tasks` into per-product tables: contradicts the one-task-system decision in BASELINE.md.
- Sharing P0's model gate, readiness and fixture-doc store with teamwork: changes P0 behavior; P0 regressions would need re-proof.
- LISTEN/NOTIFY instead of idle polling; JWT verifier sharing across apps; a page-shell module shared with P0 web: deferred.

## Checkpoint 2 /simplify skips (with reasons)

- A per-adapter `probe()` on the source port instead of sampled reads: a port change across four live adapters that cannot be tested until live resources exist. The sample's months are fixed to the seeded data; the limitation is recorded in `ACCEPTANCE_REPORT.md`.
- A field-for-error table driving every form field: only the repository error is field-specific today.
- An API-side `required` flag on connections: the page-level fixture check covers the one case.
- A shared denied-repository e2e helper: the three copies differ in segment, member and screenshot needs.
- A `shortRevision` helper: three call sites with one `slice(0, 12)` each.

## Final whole-branch review (2026-10-30)

`/code-review` (10 findings), all fixed:

- Cyclic plans are rejected or flattened.
- Retried and rescoped dependents wait for their upstream (one `releaseReady`).
- Deadlines start when a run starts.
- Login state is bound to the browser by cookie.
- Each Postgres sits on its own internal network.
- Jobs renew their lease, and every job kind has an attempt cap.
- P0 queries ignore teamwork rows (`kind`, `segment is null`).
- A segment 401 no longer loops through sign-in.
- One token memo helper.
- Also fixed:
  - The publish gate is re-checked at approval.
  - The new-task form keeps the member's source ticks.
  - The members key in the missing-config report is correct.

`/simplify` (4 reviewers) applied:

- 401 translated in the segment client.
- `canPublish` shared by prepare and approve.
- `plan()` uses `capabilitiesFor`.
- One `markUncertain`.
- One dependency `closure`.
- `run.mjs` derives ports, makes one live check and has a complete usage line.
- Shared `SESSION_TTL_S` and `membersKey`.
- `h('title')` instead of a private escaper.
- Shared `ApiResult`.
- The conversation poller pauses in hidden tabs.
- Small cleanups.

`/simplify` skips, with reasons:

- Separate teamwork tables or views instead of `kind` filters: a schema migration that P0 must re-prove; later milestone.
- A shared BFF client, CSRF and cookie helpers, static-asset helpers and client script with P0: cross-module refactors that touch P0; UI/UX milestone.
- Readiness caching, batched evidence inserts, a single inbox sync per transaction, the reply N+1, idle-claim backoff: performance work with no measured problem at M1 scale.
- Typed `ConflictCode` labels, an API-side connection `required` flag, a shared metrics form component, readiness zod schemas: UI/UX milestone.
- Merging `wholeNumber` with P0's `callLimit`: the two treat an empty value differently.
- Reusing P0's `appendEvent`: needs P0's event type widened.
- A nullable `deadline_at`: needs a migration; the queued value is now a placeholder that is overwritten at start.

## Decisions (later)

- Call caps are per ledger: live `aw-m1` 200 + 200 and local-test `aw-m1-local` 100 + 100, summing to 600. Local-test runs in its own Compose project and port (8281), so test identities never touch live volumes again.
