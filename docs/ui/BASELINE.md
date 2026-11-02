# UI milestone baseline (gate U0)

Recorded 2026-10-30 on branch `yu-iskw/ui-milestone` at `7c51edf` (M1, PR #178). The findings come from reading the code, the M1 handoff documents and the running `aw-m1-local` databases. They are not a fresh browser usability assessment.

## Working tree at start

- Clean apart from the operator's `.gitignore` block for `artifacts/ui/` media and `docs/ui/reference/*.png`, and the reference pack under `docs/ui/reference/`.
- Running Compose projects belong to other work and are left alone: `aw-p0`, `aw-m1` (databases only), `aw-m1-ux` (scripted model) and `aw-m1-local`. The UI milestone takes over `aw-m1-local` because its databases hold the persistent model ledger. It never resets those volumes.

## Scope and modes

| Concern                 | Mode in this milestone                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | Simulated: `local-test` mock members `alice@local.test` and `bob@local.test`. Labelled in the UI.                                   |
| Sources                 | Fixture files in the repository, read through the existing fixture adapter. Labelled "Demo sources".                                |
| Google Docs publication | Fixture document store (`wb_fixture_docs`). Labelled as a demo action; no live Google Docs write.                                   |
| Model                   | Real Vertex AI `gemini-3.8-flash`, location `global`, through the existing gate. No scripted, stub or replayed model in acceptance. |
| Member files            | New: bounded text, Markdown, CSV and JSON uploads that become task evidence.                                                        |

The scripted model mode (`aw-m1-ux`, `LLM_MODE=scripted`) stays in the repository for M1's own review rounds. UI milestone commands refuse it.

## Observed state of the web layer

The M1 web app is a backend-for-frontend. It renders HTML with a 100-line string JSX renderer (`apps/web/app/html.ts`), posts urlencoded forms with a per-session CSRF field and an Origin check, and enhances pages with one 266-line script (`apps/web/client/m1.ts`) that polls a task version and replaces `[data-live]` regions when they are idle.

The known baseline issues from the contract, checked against the code:

| Issue                                                  | Finding                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary conversation cannot work on sources           | Confirmed. The reply prompt says the teammate cannot read sources and should suggest a task (`apps/api/src/teamwork/prompts.ts:316-322`); the conversation panel sends the member to the standalone new-task form (`apps/web/app/m1/views.tsx`, `ConversationPanel`). |
| Completed tasks stack everything into long pages       | Confirmed. `TaskPage` renders decisions, result, assignments, evidence, discussion and activity in one document (`apps/web/app/m1/task-views.tsx`).                                                                                                                   |
| Inbox grows without bounded paging                     | Confirmed. `GET /inbox` returns up to 200 items with no cursor (`apps/api/src/teamwork/tasks.ts:1262-1293`); the page renders all of them.                                                                                                                            |
| Manual task setup shows many fixed specialist controls | Confirmed. `NewTaskPage` renders fixed assignment rows up front.                                                                                                                                                                                                      |
| Teammate settings compete with the conversation        | Confirmed. `TeammatePage` places capabilities, skills and settings beside the conversation.                                                                                                                                                                           |
| Draft isolation across members                         | Not isolated by member. Drafts are keyed `aw-m1:<segment>:<key>` in localStorage (`apps/web/client/m1.ts:4`), so Bob signing in on Alice's browser in the same segment sees Alice's unsent text.                                                                      |

Backend facts the UI depends on, with the full survey in `.scratch/ui-baseline-backend.md` (local only):

- One task store (`wb_tasks`, `wb_events`, `wb_evidence`, `wb_approvals`, `wb_actions`) plus the teamwork tables (`tw_*`). Approval, cancellation, lease, restart and reconcile invariants are enforced server-side and stay untouched.
- Listings are unbounded or capped at 200 with no cursor, filter or search. There is no results listing.
- No read markers, no attachments, no teammate appearance, no member preferences.
- `tw_messages.card` declares six card kinds, but the worker writes only `task_created` and `result_ready`.
- The adapter does not stream. Chat replies are whole messages.

## Model budget

The persistent ledger is `wb_model_calls` in each segment database. Measured before any UI work:

| Project       | Alpha | Beta |
| ------------- | ----: | ---: |
| `aw-m1`       |     4 |    1 |
| `aw-m1-local` |    79 |   57 |

The operator granted a new 600-call allowance for this milestone on top of that history. Migration `0020_model_call_campaign.sql` adds a nullable `campaign` column. The gate counts and tags only the configured campaign (`AW_MODEL_CAMPAIGN`), and history rows stay null and untouched. The UI commands run with campaign `ui-2026-10`, a cap of 300 per segment (each segment has its own database, so 600 in total), and concurrency 2 per segment. Real-model suites run one segment at a time. The cap is never raised automatically, and every retry is a counted row.

## Reuse and migration plan

The architecture is recorded in [`ARCHITECTURE.md`](ARCHITECTURE.md). In short:

- **Reused unchanged:** task, plan, assignment, evidence, revision, approval, action and inbox semantics; the task command API; the worker, leases and reconciliation; the fixture source and document adapters; mock identity and the BFF session.
- **Extended:** bounded list parameters and a results listing; conversation pages with an after-cursor and reply state; read markers; persisted card anchors posted with inbox changes; teammate appearance (avatar and accent) kept out of snapshots and exports; member files as a `member_file` evidence source; a web-side preferences table.
- **New:** a conversation workspace (Preact island and BFF JSON routes) that becomes the default surface. Existing deep links (`/s/<seg>/teammates/<id>`, `/s/<seg>/tasks/<id>`, `/s/<seg>/inbox`) open the matching conversation and panel. The M1 pages remain reachable as the accessible fallback.
- **Not added:** a second task engine, approval state held in the browser, autonomous coordinator dispatch, routines, voice, a shared Bot computer, external messaging or a sharing platform.
