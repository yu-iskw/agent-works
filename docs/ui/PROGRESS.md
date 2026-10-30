# UI milestone progress

Durable record for resuming after interruption or compaction. Newest checkpoint first. The binding contract is [`reference/IMPLEMENTATION_PROMPT.md`](reference/IMPLEMENTATION_PROMPT.md); the gate ledger lives in `ACCEPTANCE_REPORT.md` once it exists.

## Resume here

- Branch `yu-iskw/ui-milestone`, base `7c51edf` (M1, PR #178). The operator makes every commit; the agent stages explicit paths and prints `READY_TO_COMMIT`.
- Reference images: `artifacts/ui/reference/` (gitignored). Local evidence: `artifacts/ui/` (gitignored).
- Stack under test: Compose project `aw-m1-local` (mock identity, fixture sources, real Vertex), web on `http://127.0.0.1:8281`. Its Postgres volumes hold the persistent model ledger, so the UI milestone reuses the project and never resets them.

## Operator decisions (2026-10-30)

| Question           | Answer                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Git and PR         | Agent never commits or pushes. One draft PR, kept green by the agent.                                                                            |
| Real Vertex budget | New 600-call allowance for this milestone, concurrency 2, on top of the existing ledger. Never raised automatically; retries count.              |
| U20 usability      | Yu recruits three reviewers. The agent prepares the script, run instructions and recording sheet early. U20 stays PENDING until sessions happen. |
| U18 baselines      | The agent builds a local gitignored contact sheet and prints `BASELINE_REVIEW_READY <path>`. Comparisons run only against the approved files.    |
| Run mode           | Continuous; `NEEDS_YU:` only for real external blockers.                                                                                         |

## Model ledger

Measured 2026-10-30 with `select mode, purpose, count(*) from wb_model_calls where sent group by 1, 2` in each segment database.

| Project       | Segment |                           Real Vertex calls | Cap |
| ------------- | ------- | ------------------------------------------: | --: |
| `aw-m1`       | alpha   |                                           4 | 200 |
| `aw-m1`       | beta    |                                           1 | 200 |
| `aw-m1-local` | alpha   |                                          79 | 100 |
| `aw-m1-local` | beta    |                                          57 | 100 |
| `aw-m1-ux`    | alpha   | 0 (103 scripted `stub` rows, never counted) | n/a |

Total real calls before this milestone: 141. The UI allowance is counted separately by campaign (see `BASELINE.md`), 300 per segment, so 600 in total. UI milestone calls used so far: 0.

## Checkpoints

### 2026-10-30 C1: foundation (staged for commit)

- Architecture chosen (`ARCHITECTURE.md`): Preact island over a BFF JSON API, with persisted card anchors.
- Campaign-scoped budget (`0020_model_call_campaign.sql`).
- Segment API: bounded and searchable task, inbox and results lists; conversation pages with reply state; read markers; card anchors posted with inbox changes; teammate avatar and accent; member files as `member_file` evidence (`0021_ui_workspace.sql`, `0022_member_files.sql`).
- Web: Preact workspace island (shell, theme without flash, preferences, startup view, sidebar, timeline, composer key policy), BFF JSON routes with one CSRF check.
- Commands: `pnpm ui:doctor|up|down|restart|test|e2e|visual|evidence|verify|seed-review`.
- Gates run: `pnpm ui:test` PASS (install, build, typecheck, ESLint, 3294 vitest tests); Prettier and markdownlint clean on every changed file; knip clean apart from sandbox-unreadable `credentials*` paths.
- Known regression to repair: `e2e/m1/local/conversation.spec.ts` targets the old conversation markup.
- Not yet run: the stack from this branch, the live smoke, any browser check. Model calls in campaign `ui-2026-10`: 0.

### 2026-10-30 C0: grounding

- Read the contract, the specification, the reference README and all ten reference images.
- Backend survey written to `.scratch/ui-baseline-backend.md` (local only). Key facts: chat replies read no sources; no bounded listing, results endpoint, read markers, attachments, teammate appearance or member preferences exist; the ledger has no campaign dimension.
- Architecture bakeoff running: server-rendered fragments with vanilla modules against a reactive client island.
