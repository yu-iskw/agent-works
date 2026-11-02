# UI milestone progress

Durable record for resuming after interruption or compaction. Newest checkpoint first. The binding contract is [`reference/IMPLEMENTATION_PROMPT.md`](reference/IMPLEMENTATION_PROMPT.md); the gate ledger lives in `ACCEPTANCE_REPORT.md` once it exists.

## Resume here

- Branch `yu-iskw/u20-review-accounts`, base main `5732102` (PR #181, merged 2026-11-02 15:06 JST, on top of PR #179 `5600e00`). The operator makes every commit; the agent stages explicit paths and prints `READY_TO_COMMIT`.
- Reference images: `artifacts/ui/reference/` (gitignored). Local evidence: `artifacts/ui/` (gitignored).
- Stack under test: Compose project `aw-m1-local` (mock identity, fixture sources, real Vertex), web on `http://127.0.0.1:8281`. Its Postgres volumes hold the persistent model ledger, so the UI milestone reuses the project and never resets them.

## Standing orders

- (2026-11-02 10:12 JST, Yu) Keep working until every CI job on PR #179 is green. After each push, treat any red check as the next task: read the failure, fix it, stage it, print `READY_TO_COMMIT`, keep going. The only accepted exception is "Generate and scan SBOM" (`minimatch` GHSA-g3hv-75wg-m249), which waits for the 11.0.1 pin after 2026-11-04 07:26 JST with no quarantine exclusions. Fulfilled: PR #179 was squash-merged as `5600e00` at 13:50 JST on 2026-11-02.
- (2026-11-02 10:13 JST, Yu) U18 baselines approved: `artifacts/ui/baselines/candidate-2026-10-31/` is the approved set, copied to `artifacts/ui/baselines/approved/` (47 files, sha256 in `manifest.json`). If a change alters rendering, re-capture, flag every diff against these baselines, and bring it to Yu.
- (2026-11-02 13:40 JST, Yu) "I re-approve candidate-2026-11-02-u20 (the 3 sign-in screenshots)".

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

Total real calls before this milestone: 141. The UI allowance is counted separately by campaign (see `BASELINE.md`), 300 per segment, so 600 in total. UI milestone calls used so far (measured 2026-11-02 14:05 JST): alpha 243, beta 151, 394 of 600.

## Checkpoints

### 2026-11-02: U20 reviewer accounts on main

- PR #179 was squash-merged as `5600e00` at 13:50 JST on 2026-11-02. The pre-merge commits cited in older checkpoints (`e4e9290`, `3aea62b`, `147775b`) are not on main; they are on the pre-merge branch, squashed into `5600e00`.
- (2026-11-02 13:07 JST, Yu) U20 option (b): one clean mock account per session, `review1@local.test` to `review3@local.test`; Yu re-approves the 3 sign-in baselines.
- The accounts are in the web's mock member list and the segment APIs' `AW_LOCAL_TEST_MEMBERS`. `pnpm ui:seed-review` accepts only them, since tests own alice, bob and carol. Measured 2026-11-02 on the `aw-m1-local` stack: `--member=review1` (and review2, review3) each exit 0 with 0 model calls, and each account keeps 7 active teammates per segment before and after; `--member=bob` is refused with exit 2. Starter teams are seeded for all three in both segments (7 teammates each, unchanged by a rerun, 0 calls). The real-model part (`--with-approval`, 8 calls) runs on the day of each session, because the approval is open for 24 hours.
- Ledger, campaign `ui-2026-10`, measured 2026-11-02 14:05 JST before this run's gates: alpha 243, beta 151, 394 of 600.
- `pnpm ui:visual`: 44 of 47 match the approved baselines. The 3 sign-in captures differ only by the three new buttons and wait for Yu in `artifacts/ui/baselines/candidate-2026-11-02-u20/`. U18 is PENDING until then.
- (2026-11-02 13:40 JST, Yu) "I re-approve candidate-2026-11-02-u20 (the 3 sign-in screenshots)". The three files replace the sign-in files in `approved/` (manifest sha256 updated, the other 44 unchanged). `pnpm ui:visual`: 47 of 47 match; U18 is PASS.
- The first focused run after the accounts change failed 3 tests, all from my earlier `seed-review --member=bob`, run before Yu's decision. It gave bob a starter team and an approval card that names `bob@local.test`. Three tests found the signed-in member by bare text, now ambiguous; they read the identity element (`.who-mail`) instead. Two isolation checks rely on bob having no starter team; the 14 teammates that seed added (7 per segment, created 2026-11-02) are archived, which restores bob's test state. Reviewer seeding now refuses bob, so this cannot recur.
- Targeted focused run on `889c880`: `node scripts/ui/run.mjs e2e focused --grep "identity|isolation|sidebar"` exit 0, 24 passed, retries 0, 5.7 min (2026-11-02).
- Seed idempotency (2026-11-02): `pnpm ui:seed-review -- --member=review1`, `review2` and `review3` each exit 0 with 0 model calls and 7 active teammates per segment, unchanged by the rerun. `--member=bob` exits 2.
- Seed guard proof (T2), in the e2e container with `playwright test --list --project=seed`: `SEED_MEMBER=bob@local.test` exits 1 (`SEED_MEMBER must be review1@local.test, review2@local.test or review3@local.test; got bob@local.test`). Unset exits 1 ("got unset"). `review1@local.test` exits 0 and lists 2 tests.
- Visual flake on `889c880`: `pnpm ui:visual` run 1 failed only "targeted states, dark, 1440". Seven sidebar captures differed by 9,639 pixels each. Root cause: the sidebar tab is saved as carol's `lastContext` preference 500 ms after a switch. The light 1440 test can end before the last save, so the dark test opened on a stale tab. Fix in `223c58d` deletes carol's `lastContext` row before each capture. Run 2 on the same build passed 47 of 47.
- Gate results on `ebd5801`: `pnpm ui:test` exit 0 (307 test files passed, 4 skipped). `pnpm ui:visual` run twice, exit 0, 12 tests passed, 47 of 47 match each time, retries 0. No baseline changed.
- `/code-review` and `/simplify` (T4) on `git diff 5600e00...ebd5801`: no P0 or P1. Three P2 items were left as they are: the member list is hand-duplicated in compose, the web config and the e2e `Member` type; the `review[1-3]` check is repeated in `run.mjs`, `seed-review.mjs` and the seed spec; the seed spec throws at module level.
- Host verify set on `ebd5801` (host, Conductor): `pnpm lint:eslint`, `pnpm knip` and `pnpm lint` PASS. `pnpm test`: 310 of 311 files, 3560 tests passed, 1 skipped, 1 failed. The failure was `packages/common` `create-adr-script.test.ts` ("passes the portable bash regression harness"), which timed out at 6517 ms under load. Rerun alone on the host: exit 0, 1 of 1 passed in 3.56 s. Host verify: GREEN, flake noted.
- Earlier host `pnpm test` run on the same tree (T5 triage): 12 failures, all load-only. 11 were timeouts in a 959 s run. The one assertion in `apps/api` `teamwork.test.ts` was a knock-on of the timed-out "pages 120 tasks" test, whose seeding kept inserting after the next test truncated the table. The 3 files passed 73 of 73 alone. `apps/api` and `packages` are unchanged by this PR, so the failures are pre-existing on main.
- 0 model calls this run. Ledger stays at alpha 243, beta 151 (394 of 600) before and after.

### 2026-11-02 C8: final journeys, usability seed, docs

- C4 committed as `3aea62b`; CI 18 of 19 green, the red one being SBOM (`minimatch`, expected until 2026-11-04).
- U14: the first all-six run passed 5 and failed journey 2, which could not find "Business context researcher". The focused identity test renames alice's first teammate (that one) and never put it back. It now restores the template identity after each test. The rerun passed 6 of 6, retries 0, 28 calls.
- U20 kit: `pnpm ui:seed-review --with-approval` exited "not implemented", yet task 4 depended on it, and task 5 asked for conversion-rate work that no fixture can produce. The flag now runs `e2e/ui/seed/` as the reviewer with real Gemini: a research task to a result with an open publication approval in alpha, and the no-show metrics work in beta. Task 5 now asks for the no-show work. It skips what exists, so a rerun spends 0; the first run spent 8 (4 per segment). It reuses the journey steps (`runToResult`, shared with `runJourney`). The starter seed also skipped any member who had any teammate, which left bob without a Coordinator; it now always posts the idempotent starter request (14 teammates before and after a rerun).
- Open for Yu: bob is also a test account. His alpha workspace holds seven "Data analyst" teammates from M1 tests and seeded focused-test tasks, and three reviewers on one account would see each other's work. A dedicated mock member per session would fix both, but the sign-in page lists every mock member, so three approved sign-in captures would change.

### 2026-11-02 C7: simplify pass and the U18 comparison

- `/simplify` on the uncommitted batch: the conversation route reads `after` once, a stale doc line in the BFF loader is gone, the cursor id regexes carry one merged doc comment, `retryFile` returns early instead of a double null check, and "Show earlier messages" is one `async` function instead of a promise chain. Kept as is: the two cursor regexes stay literal rather than built from `UUID_PATTERN`, because the security lint refuses non-literal regexes (the BFF route table makes the same choice).
- First comparison against Yu's approved baselines: 4 of 47 differed, neither from the simplify edits. Three showed "Unread" and "New result" on the open coordinator conversation, because the per-capture reset cleared every read marker; it now reproduces the approved read state (coordinator read, everything else unread). Running work had lost the specialists' finished contributions: the paged conversation query linked tasks by conversation and result owner but not by assignment, unlike the old teammate page the client had silently used. The query now matches, with an API test that fails without it. Second run: 47 of 47 match. U18 is PASS on Yu's approval.
- A focused-suite failure (`rapid Enter plus a click`) was the test's guard: it waited only for "Waiting for …'s reply", so it sent while the reply was running ("… is replying") and the API correctly refused with `reply_pending`. The guard now covers both states.

### 2026-11-02 C6: code review fixes

- C2 committed as `f564272`, CI fix as `579aa83` (root Playwright config skips the m1 and ui suites). SBOM stays red on `minimatch` GHSA-g3hv-75wg-m249 until 11.0.1 clears the 7-day quarantine on 2026-11-04 07:26 JST; Yu chose to pin it then with no exclusions.
- `/code-review` (high) on the branch returned 10 candidates. Each was checked against the code; all 10 were real and are fixed, each with a test that fails on the committed code and passes on the fix:
  1. A file upload that finished after the member switched conversations removed the stored file and left the chip uploading forever. The check now reads the draft of the conversation the upload started in. One `draftOf` replaces three copies.
  2. Polling with `after` could skip a message that committed late with an earlier timestamp. A poll now also returns the rows of a 10 s window at or before its cursor, which never move the cursor; the client merges by id.
  3. Older messages were unreachable. The real cause was larger: the BFF's strict page schema rejected the segment's `segment` echo, so every conversation silently used the 100-message fallback with no cursors. The BFF now strips both envelope keys, refuses a page another segment answered, and returns 502 `bad_contract` instead of falling back on a parse failure. "Show earlier messages" pages back with `before` and keeps the reading position.
  4. The upload route refused `text/csv; charset=utf-8` and dropped the segment's explanation. Media types are normalized, the code matches the API, and the explanation (for example which CSV row is wrong) reaches the member.
  5. Work "Needs you" counted informational `completed` inbox items; teammate rows did not. Both now use the domain's decision kinds.
  6. A forged cursor reached Postgres casts and returned 500. Cursor ids are validated as a uuid or `<taskId>:<revision>`, so it is a 400.
  7. A remove racing a send could remove a file the message referenced. Resolution share-locks the rows.
  8. A stray empty `core` file was committed at the root. Deleted and ignored.
  9. The dead `send()` effect is removed.
  10. The avatar and accent lists in the contract are pinned to the domain by a test; the BFF list limit uses the API's maximum.
- Making cursor paging real exposed two timeline defects, both fixed. A member scrolling up while cards were still settling was pulled back to the bottom, because a time-based guard ignored scrolls within 200 ms of each auto-pin and every settle re-pinned; the timeline now compares the scroll offset with where it last pinned. Paging back held the distance from the bottom, but older messages can land below the contributions of old tasks; it now holds the item the member is looking at and stops following. The timeline focused tests passed three runs in a row.
- UX round 3 found the phone sidebar sliding across the conversation when the window narrows: the closed sheet carried a 0.2 s transition and a delayed hide. Only opening animates now; a regression check reads the computed visibility at once and fails on the old CSS.

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
- Live smoke (U2), 2026-10-30T04:44Z, `gemini-3.8-flash` in `global` on project `your-gcp-project-id`. Alpha: response `xCDkatayMKOLx9gPqtXC8Q4`, model version `gemini-3.8-flash`, 1658 ms. Beta: response `xyDkapfFGLycvdAPhaecoQo`, model version `gemini-3.8-flash`, 5168 ms. Ledger ids continued from history (alpha 80, beta 58).
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
