# M1 UX iterations

Each round runs `pnpm m1:ux <round>` on the separate `aw-m1-ux` stack. That stack uses the labelled scripted model, local-test identities and fixture sources, so a round spends no Vertex calls. The round records the key journey on video (`artifacts/m1/videos/ux-round-<n>/`) and captures 22 screens at 375, 768 and 1440 px (`artifacts/m1/ux/round-<n>/<screen>-<width>.png`). `scripts/m1/video-sheet.mjs` turns the video into a timestamped contact sheet (`artifacts/m1/ux/round-<n>/video-sheet.png`) for review. All media stays local and gitignored.

Defects found in the real-model local browser suites are listed with the round that fixed them.

## Round 1 (2026-10-30)

Files inspected: `video-sheet.png` (17 frames, 32 s), `10-task-ready-1440.png`, `13-action-approval-375.png`, plus the earlier real-model screenshots `x-teammates`, `x-teammate`, `x-new-task`, `x-task-ready` (1440).

| ID   | Defect                                                                                                                                                                                                                         | Fix                                                                                                                                                                                                               | Files                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| R1-0 | The new-task form pre-ticked every workflow source for every specialist. The data analyst was handed the Drive context folder it cannot read, and the assignment failed only after it started (found when the tour first ran). | The server refuses such an assignment at creation with a member-facing reason. Each specialist row now ticks only the sources that teammate can use and greys out the rest, updating when the specialist changes. | `apps/api/src/teamwork/tasks.ts` (`checkSourcesUsable`), `apps/web/app/m1/task-views.tsx`, `apps/web/client/m1.ts`, `labels.ts` |
| R1-1 | Tour harness: screens were captured after later steps ran, so "approval" showed the published state.                                                                                                                           | Capture all three widths at the moment each screen exists.                                                                                                                                                        | `e2e/m1/ux/tour.spec.ts`                                                                                                        |
| R1-2 | The Discussion panel showed "Waiting for a reply" after a revision request, which never gets a reply.                                                                                                                          | Messages carry `pending` from the stored reply state. The badge shows only for a real pending question.                                                                                                           | `packages/domain/src/teamwork.ts`, `tasks.ts`, `conversations.ts`, `task-views.tsx`                                             |
| R1-3 | At 375 px the task page was 5,667 px tall. The full activity log (25+ entries) buried evidence and actions.                                                                                                                    | Activity shows the latest 6 events and puts the rest behind "Show all N events".                                                                                                                                  | `task-views.tsx`, `styles.ts`                                                                                                   |
| R1-4 | **Request revision** stretched to full width on desktop and read like a banner.                                                                                                                                                | Buttons in form grids align to the start.                                                                                                                                                                         | `styles.ts`                                                                                                                     |
| R1-5 | Evidence cards showed a bare hash such as `018b6a9c9965`.                                                                                                                                                                      | Labelled "Source version …".                                                                                                                                                                                      | `task-views.tsx`                                                                                                                |
| R1-6 | Below 600 px the local-test, fixture and scripted-model labels disappeared, because the topbar badges were hidden. Every page must stay labelled.                                                                              | The mode labels moved into the segment bar, which is visible at every width.                                                                                                                                      | `views.tsx`, `styles.ts`                                                                                                        |
| R1-7 | At 768 px, four badges crowded the brand in the topbar (video frames at 20 s and 28 s).                                                                                                                                        | Only the model-usage badge remains in the topbar, hidden below 900 px. Mode labels live in the segment bar.                                                                                                       | `views.tsx`                                                                                                                     |
| R1-8 | The Published card said "revision 2" twice (title and sentence).                                                                                                                                                               | The sentence names the title and the account only.                                                                                                                                                                | `task-views.tsx`                                                                                                                |
| R1-9 | Scripted content quoted document headers ("AW-M1 Alpha: …", "Last reviewed: …"), which made review screens unrealistic.                                                                                                        | The scripted model skips header and metadata lines. A 3 s pause makes the running and planning states visible.                                                                                                    | `apps/api/src/teamwork/scripted-model.ts`                                                                                       |

Earlier fixes from the real-model local suites (before rounds started): mobile menu focus blocked by a visibility transition, evidence duplicated across assignments, truncated task titles, and one-time notices repeated on reload.

## Round 2 (2026-10-30)

Files inspected: `video-sheet.png` (12 frames, 47 s), `13-action-approval-375.png`, `15-plan-review-768.png`, `07-new-task-research-375.png`. Compared against round 1: the approval screen now shows the pending approval (R1-1 fixed). The mode labels are visible at 375 and 768 in the segment bar (R1-6, R1-7). The 375 approval page is 5,502 px tall instead of 5,667 px (R1-3).

| ID   | Defect                                                                                                                                                                                                                             | Fix                                                                                                                        | Files                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| R2-1 | After a redirect to `#decision`, the 92 px sticky header and segment bar covered the decision card's heading on phones ("Approve this exact Google Doc?" was hidden). A reviewer could reach the approve button without its title. | `scroll-margin-top: 110px` on the decision card and evidence cards.                                                        | `apps/web/app/m1/styles.ts`  |
| R2-2 | Two messages said the same thing when a publication was prepared: the notice "Review the exact document below…" and the status line.                                                                                               | Dropped the notice. The status line and the card carry it.                                                                 | `apps/web/app/m1/handler.ts` |
| R2-3 | The activity log showed two near-identical events ("Coordinator is drafting a plan for your review" and "… (no work is dispatched yet)") and "1 assignments".                                                                      | Creation event reworded. Plural fixed.                                                                                     | `tasks.ts`, `worker.ts`      |
| R2-4 | During plan review, the result area said only "No result yet."                                                                                                                                                                     | A state-specific placeholder says what happens next (after approval, after the open decision, or why nothing was written). | `task-views.tsx`             |
| R2-5 | At 375 px the segment pill wrapped "Alpha Retail" onto two lines and pushed the topbar out of alignment.                                                                                                                           | The pill name is truncated with an ellipsis. The segment bar shows it in full.                                             | `styles.ts`                  |
| R2-6 | The scripted plan picked one context researcher for a research brief, so the plan card could not be judged realistically.                                                                                                          | The scripted coordinator picks specialists by workflow source.                                                             | `scripted-model.ts`          |

Not changed, with reasons: three assignment rows on the 375 px new-task form are long, but each row is needed for manual parallel work. The ticks there are correct without JavaScript, and they adjust once a specialist is picked (R1-0).

## Round 3 (2026-10-30)

Files inspected: `video-sheet.png` (12 frames), `15-plan-review-375.png`, `18-inbox-with-items-768.png`. Compared against round 2: the plan card shows two realistic parallel specialists (R2-6). The placeholder explains the next step (R2-4). The segment pill fits on one line (R2-5). The activity log has distinct events (R2-3).

| ID   | Defect                                                                                                                                                                                                                                            | Fix                                                                                                                                                                                                                     | Files                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| R3-1 | At 375 px the task page rendered 393 px wide: menu, brand, segment pill, avatar and sign-out did not fit, so sign-out was clipped and the page scrolled sideways. The accessibility suite checked overflow on list pages only, so it missed this. | Below 600 px the brand text is hidden (the link keeps the accessible name "Agent Works, go to inbox") and the pill truncates sooner. The tour now soft-asserts zero horizontal overflow on every screen at every width. | `styles.ts`, `views.tsx`, `e2e/m1/ux/tour.spec.ts` |
| R3-2 | Inbox items for missing contributions were labelled "Question", but they ask for a decision, not an answer.                                                                                                                                       | The label for that inbox group is now "Needs you".                                                                                                                                                                      | `labels.ts`                                        |

## Round 4 (2026-10-30)

Files inspected: `16-metrics-result-1440.png`, `12-revision-compare-768.png`, plus the tour's overflow assertions (none failed on 22 screens × 3 widths, so R3-1 is fixed). The comparison page is clear: changed sections are badged, removed lines are struck through, added lines are green, and unchanged sections collapse to a count.

| ID   | Defect                                                                                                                                                                   | Fix                                                                                                                  | Files                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| R4-1 | The calculations table repeated the month in every cell ("142,092 2026-09") and the grouping in every row ("region APAC"), so the numbers wrapped and were hard to scan. | The column headers carry the grouping ("Region") and the two periods ("2026-09", "2026-10"). Cells hold only values. | `apps/web/app/m1/task-views.tsx` |
| R4-2 | Scripted content titled every result "Decision brief", even metrics and engineering results.                                                                             | The scripted model titles by workflow.                                                                               | `scripted-model.ts`              |

## Round 5 (2026-10-30): no new defects worth fixing

Files inspected: `16-metrics-result-375.png`, plus the overflow assertions on all 22 screens at three widths (all pass). The calculations table scrolls inside its own container at 375 px while the page does not, and the period and region headers read cleanly (R4-1). The metrics result is titled by workflow (R4-2).

Remaining known issues, deliberately not changed:

- At 375 px a finished task page is still about 4,500 px tall, because evidence and activity stack below the result. Evidence is always one tap away through the citation links (`#ev-E1`), and activity is collapsed to 6 events. Moving evidence into a drawer is a design change for the human review to weigh in on.
- The manual new-task form shows three assignment rows at every width. A dynamic "add specialist" control would shorten it but needs JavaScript. The server-rendered form works without it.
- Review rounds use the scripted model, so the content of statements in these screenshots is canned. The real-model local suites and the live journeys judge the content itself.

Rounds completed before the first checkpoint: 5 (2 required).

## Round 6 (2026-10-30): post-/simplify regression check, no new defects

Files inspected: `video-sheet.png` (13 frames, 48 s), `13-action-approval-1440.png`, plus the overflow assertions on 22 screens × 3 widths (all pass). The refactor kept every screen's structure and copy. The approval card shows account, destination, operation, title, revision, length, expiry and the exact content, with the consequences listed before the decision buttons.

Note on captures: a full-page screenshot taken after the `#decision` jump draws the sticky header at the scroll position, partway down the image. That is how the capture is made, not a layout defect; in a real viewport the card lands below the header (R2-1).

Rounds completed before the first checkpoint: 6.

## Round 7 (2026-10-30): checkpoint 2 screens

New in this checkpoint, so the tour gained two screens: the live-source check (`19b-source-checks`) and the refused repository (`19c-repository-refused-1440`). Timestamps now render as `<time>` elements and show the viewer's local time, with UTC in the tooltip (the earlier known issue).

Files inspected: `19b-source-checks-375.png`, `19c-repository-refused-1440.png`.

| ID   | Defect                                                                                                                                                     | Fix                                                                                                           | Files                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| R7-1 | At 375 px the source-check table clipped its Details column inside a sideways scroller, and the source names wrapped onto three or four lines.             | The checks are a list: status badge and source name on one line, details below, wrapping freely.              | `apps/web/app/m1/views.tsx`, `styles.ts` |
| R7-2 | In fixture mode, both provider cards said "This provider is not configured yet" right above a check showing every source reachable. That is contradictory. | In fixture mode the cards say the stack reads local fixture files, so no connection is needed.                | `views.tsx`                              |
| R7-3 | The metrics check read "data modified unknown".                                                                                                            | When a source reports no freshness, it says so plainly.                                                       | `apps/api/src/teamwork/diagnostics.ts`   |
| R7-4 | A refused repository was reported only at the top of the form. The field itself was not marked, and the page did not say which repositories are allowed.   | The repository field gets `aria-invalid`, and its hint becomes an inline error naming the allowed repository. | `task-views.tsx`, `handler.ts`           |

## Round 8 (2026-10-30): round 7 fixes confirmed, no new defects

Files inspected: `19b-source-checks-375.png`, `19c-repository-refused-1440.png`, plus the overflow assertions on 24 screens × 3 widths (all pass, 51 s run). At 375 px each source check is one badge and name line with its details wrapped below, and nothing scrolls sideways (R7-1). In fixture mode both provider cards say no connection is needed (R7-2). The metrics check says "freshness not reported by this source" (R7-3). The refused repository field is marked invalid and names the allowed repository inline (R7-4).

Remaining known issues are unchanged from round 5.

Rounds completed before the second checkpoint: 8.

## Round 9 (2026-10-30): after /code-review and /simplify

Files inspected: `19b-source-checks-768.png`, `19c-repository-refused-1440.png`, plus the overflow assertions on 24 screens × 3 widths (all pass). The fixture note now appears once at the top of Connections instead of inside each provider card. The refused repository hint lists every allowlisted repository.

| ID   | Defect                                                                                                                                                                             | Fix                                                                                                                                        | Files                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| R9-1 | In fixture mode both provider cards still showed a "Not connected" badge right under the note that says no connection is needed.                                                   | In fixture mode the badge reads "Not needed here".                                                                                         | `apps/web/app/m1/views.tsx` |
| R9-2 | On the scripted review stack, the model card said the segment calls `scripted-ui-review` "with the operator's model credential", which is false: that stack makes no Vertex calls. | The card is titled "Model (scripted review)" and says it answers with canned review content, makes no Vertex calls and uses no credential. | `views.tsx`                 |

## Round 10 (2026-10-30): round 9 fixes confirmed, no new defects

Files inspected: `19-connections-375.png`, plus the overflow assertions on 24 screens × 3 widths (all pass). Both provider cards read "Not needed here" below the single fixture note, and the model card describes the scripted stack accurately. The accessibility suite (axe at three widths) passes again on the local-test stack.

Remaining known issues are unchanged from round 5.

Rounds completed before the second checkpoint: 10.

## Round 11 (2026-10-30): mock-only rescope

By Yu's decision M1 is mock-only apart from the real model, so the labels changed: the segment bar says "Mock identity", the sign-in card says "Mock identities", and Connections says Google and GitHub are mocked. Files inspected: `01-sign-in-375.png`, `02-inbox-375.png`, plus the overflow assertions on 24 screens × 3 widths (all pass).

| ID    | Defect                                                                                                                                | Fix                                                               | Files                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------- |
| R11-1 | In mock mode, the sign-in card still said "Sign in with your work Google account", right above the notice that identities are mocked. | In mock mode the line reads "Choose a mock identity to continue." | `apps/web/app/m1/views.tsx` |

Not fixed, handed to the UI/UX milestone (`docs/m1/NEXT_MILESTONE.md`): the inbox has no paging. After 11 rounds of accumulated review tasks it is about 9,000 px tall at 375 px.

## Round 12 (2026-10-30): after the final /code-review and /simplify

Files inspected: `01-sign-in-768.png`, `19-connections-768.png`, plus the overflow assertions on 24 screens × 3 widths (all pass). The sign-in card now says "Choose a mock identity to continue" (R11-1).

| ID    | Defect                                                                                                                                                                           | Fix                                                                                                                                    | Files                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| R12-1 | On the mock stack the source check was titled "Live sources" with a "Check live sources" button, and it said it reads "with your own connections". Neither is true in mock mode. | It is titled "Sources in \<segment\>" with a "Check sources" button. In fixture mode the text says it reads the local fixture sources. | `apps/web/app/m1/views.tsx`, suites |

## Round 13 (2026-10-30): R12-1 confirmed, no new defects

Files inspected: `19b-source-checks-375.png`, plus the overflow assertions on 24 screens × 3 widths (all pass). The check is titled "Sources in Alpha Retail", the button reads "Check sources", and the text says it reads the local fixture sources. Every mode label (mock identity, fixture sources, scripted model) shows at 375 px.

Remaining known issues are handed to the UI/UX milestone in `docs/m1/NEXT_MILESTONE.md`.

Rounds completed in M1: 13.
