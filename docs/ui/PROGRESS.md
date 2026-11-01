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

### 2026-11-01 C5: visual baselines ready for review

- `pnpm ui:visual` renders carol, a mock member reserved for baselines. Her reviewed research task was generated once with real Gemini (10 alpha calls); the running and failed states are seeded rows. The clock is frozen ten minutes after her approval was requested and the live call counter is masked.
- Inspection of the captures found and fixed three defects: the approval panel chip said "pending" for an approval the card called expired, panel headings drew an input-like focus box, and the timeline was clipped sideways at 768 px. Details in `VISUAL_REVIEW.md`.
- 47 captures frozen in `artifacts/ui/baselines/candidate-2026-10-31/` with a sha256 manifest; contact sheet `artifacts/ui/contact-sheet.html` printed as `BASELINE_REVIEW_READY`. U18 waits on Yu.
- Subagents hit the Fable model limit during E2E-3; the coordinator finished the unit directly.
- Campaign calls used: alpha 165 of 300, beta 99 of 300.

### 2026-11-01 C4: focused suite, approvals, isolation, restart, security checks

- Focused suite (`pnpm ui:e2e focused`, retries 0): 71 passed, 0 failed, 0 skipped, 10.3 min. It covers the panel, composer, sidebar, identity, deep links, startup and theme, timeline scroll and reconnect, keyboard-only journey, inbox, approvals (deny, approve once, stale, expired, uncertain and reconcile, publish failure), recovery (inbox answer, partial failure, cancellation), isolation (account switch, segment switch, direct requests, CSRF), XSS and export privacy, and axe scans of 19 states at 375, 768 and 1440 px in both themes (no critical or serious violations, no horizontal overflow).
- Restart (`pnpm ui:restart`): `api-alpha` killed mid-assignment; the work resumed once after the restart and the conversation and draft survived.
- `pnpm ui:doctor` security checks all PASS: ADC only on the two segment APIs and read-only, no ADC in the image or its history, no credential field in container logs, no credential value in the evidence tree, CSP `script-src 'self'` without `unsafe-inline`.
- Fixes in this round: sign-out now clears every key of the member in every segment and closes the draft store, because a late debounced write re-created drafts after sign-out. A publish control for the latest revision was added (labelled as the demo document store). The approval seed helper no longer shadows real tasks in the citation tests. The doctor's evidence scan looks for credential values, not field names, after it flagged its own report. Moderate axe findings (heading order, main landmark, one h1) fixed.
- Observed once, not reproduced since: the "New activity" timeline test failed in one full focused run and passed in every later run, alone and in order. Watch it in the final run.
- E2E specs have no tsconfig, so an undefined import surfaced only at run time; the M1 specs share this setup.
- Campaign calls used: alpha 155 of 300, beta 99 of 300.

### 2026-10-31 C3: six real-model journeys

- Six journeys written (`e2e/ui/journeys/`), run through `pnpm ui:e2e journeys` with retries off. Records in `artifacts/ui/journeys/<n>.json`, videos in `artifacts/ui/videos/`.
- Root cause found for failing revisions: Gemini 3.8 Flash thinking consumed the 60 s timeout and the shared 8192-token output budget on revision calls (48 to 52 s, about 316 visible tokens, truncated JSON). Artifact synthesis and revision now request `thinkingLevel: low`. Measured after the change: revision 12.9 s with 2467 tokens, synthesis 10.5 s. Same model, same timeout.
- Root cause found for an empty Changes view: the revision diff ignored limitations and the title. A revision that only added a limitation was shown as unchanged. Fixed in `diffRevisions` with a test.
- Journey 5's revision request was already satisfied by revision 1, so the model correctly returned identical content; the request now asks for new content. The Changes view states "No content or source changes" when that happens.
- Last full run (`pnpm ui:e2e journeys`, retries 0): journeys 1, 2, 3, 4 and 6 passed; journey 5 failed on the diff bug, then passed alone after both fixes. A final all-six run is still owed at acceptance.
- UI fixes from the journeys: fixture-mode sources were disabled in menus; metrics month fields reset while typing; follow-up targets picked the oldest tasks; the question card crashed on plain HTTP; the ambiguous-target chip could not open its choices; contribution cards now name their task.
- Known product gap: starting a task from a specialist's conversation defaults the result owner to that specialist, but only the Coordinator has a synthesis skill, so Start fails with `no_synthesis_skill` unless the owner is changed under Edit.
- Campaign calls used: alpha 93 of 300, beta 86 of 300.

### 2026-10-30 C2: live stack, smoke and UX round 1

- C1 committed as `e4e9290`, draft PR #179. CI fixes staged (CodeQL navigation guard, case-insensitive script regex, stylelint config package).
- `pnpm ui:up` from this branch: both segments healthy, migrations 0020 to 0022 applied. `pnpm ui:doctor`: every check PASS.
- Live smoke (U2), 2026-10-30T04:44Z, `gemini-3.8-flash` in `global` on project `ubie-yu-sandbox`. Alpha: response `xCDkatayMKOLx9gPqtXC8Q4`, model version `gemini-3.8-flash`, 1658 ms. Beta: response `xyDkapfFGLycvdAPhaecoQo`, model version `gemini-3.8-flash`, 5168 ms. Ledger ids continued from history (alpha 80, beta 58).
- UX round 1 (`pnpm ui:e2e ux 1`, captures in `artifacts/ui/screenshots/round-1/`, video in `artifacts/ui/test-results/ux/`). One real reply (6.9 s). Defects found and fixed: sending failed on plain HTTP because `crypto.randomUUID` needs a secure context (now `getRandomValues`). Defects handed to WEB-2c: header overlap at 768 px and with the panel open, phone sidebar open and clipped on load, member initials "A(", no default curated avatars, open conversation keeps "Unread". Raw Markdown in replies handed to WEB-2a.
- In progress: WEB-2a (cards, Markdown, review panel), WEB-2b (composer menus, chips, files, task draft), WEB-2c (sidebar lists, inbox, identity, preferences, recap, responsive fixes).
- Campaign calls used: alpha 3 (1 smoke, 2 replies), beta 1 (smoke).

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
