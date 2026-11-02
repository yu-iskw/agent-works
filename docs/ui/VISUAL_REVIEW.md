# UI milestone visual review (gate U18)

Status: **PASS** (Yu approved the baselines on 2026-11-02; the comparison run against them matches)

Yu approves the baseline candidates. A machine run never marks this gate PASS, and nothing writes `artifacts/ui/baselines/approved/` except an approval Yu gives.

## How the captures are made

`pnpm ui:visual` runs `e2e/ui/visual/` against the Compose stack. Every capture renders carol's workspace in segment alpha. carol is a mock member reserved for baselines, so no other test changes what she sees.

| Content                                                                                | Provenance                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation, result review, citations, revision changes, plan review, action approval | carol's reviewed research task, generated once by real Gemini (`gemini-3.8-flash`, campaign `ui-2026-10`) through the journey steps, then rendered from the database with no new model call. |
| Running work                                                                           | A seeded task (`llm_mode` `stub`) with one assignment working and one queued. Rendering only.                                                                                                |
| Recoverable failure                                                                    | A seeded task that stopped at synthesis. Rendering only.                                                                                                                                     |
| Sign-in                                                                                | No generated content.                                                                                                                                                                        |

The browser clock is frozen ten minutes after carol's approval was requested, so the approval stays open and relative times do not move. The live model-call counter in the header is masked, because it changes with every call in the segment. Nothing else is masked. Before each capture carol's read state is reset to the same point (her coordinator conversation read, every other conversation unread) and the timed read marker is blocked, so no Unread label depends on timing. A capture waits until every linked task's detail has loaded (`aria-busy="false"` on the timeline). A capture matches when at most 64 pixels differ.

`pnpm ui:contact-sheet` freezes the current captures into `artifacts/ui/baselines/candidate-<date>/` with a sha256 manifest and writes `artifacts/ui/contact-sheet.html`. Both are local and gitignored.

## Required coverage

Conversation, running work, result review and action approval, each in light and dark at 1440, 768 and 375 CSS pixels: 24 captures. Targeted captures at 1440 in both themes: citation source, revision changes, plan review, recoverable failure, inbox, teammate customization, preferences, sidebar Work, sidebar Results and the composer mention menu: 20 captures. Sign-in at three widths: 3 captures. 47 in total.

## Defects found by inspection and fixed before review

| Capture                                  | Defect                                                                                                                       | Fix                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Action approval, all widths              | The timeline card said "Expired before a decision" while the panel chip said "pending" for the same approval.                | The panel chip now shows the same validity label as the card (Expired, Stale, or the decided state).      |
| Result review and action approval panels | A focus outline made the panel heading look like a text input after the panel opened.                                        | Headings that take focus only so screen readers land on the new surface no longer draw a control outline. |
| Running work at 768 px                   | The timeline was clipped on the right: the contribution's task link and the work card's status chip ran past the scroll box. | The timeline grid column is `minmax(0, 1fr)`, so long lines ellipsize instead of widening the column.     |
| Every capture                            | The live call counter would change on every run.                                                                             | Masked in the capture.                                                                                    |

## Approval

Candidates under review: `artifacts/ui/baselines/candidate-2026-10-31/` (47 files, sha256 in `manifest.json`), contact sheet `artifacts/ui/contact-sheet.html`.

When Yu approves, those exact files are copied to `artifacts/ui/baselines/approved/` and this file records the date, the candidate folder and any defects Yu listed. `pnpm ui:visual` then compares new captures against them and reports PASS only when every capture matches.

| Date                 | Reviewer | Candidate set          | Outcome  | Notes                                                                                               |
| -------------------- | -------- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------- |
| 2026-11-02 10:13 JST | Yu       | `candidate-2026-10-31` | Approved | "artifacts/ui/contact-sheet.html looks ok right now." Copied to `artifacts/ui/baselines/approved/`. |

## Comparison runs after approval

| Date       | Build                                   | Result                    | Notes                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-02 | working tree after `/code-review` fixes | 4 of 47 differed          | Three captures showed "Unread" and "New result" on the open coordinator conversation, because the capture reset every read marker; the reset now reproduces the approved read state. Running work had lost the specialists' finished contributions: the paged conversation query no longer linked tasks a teammate is assigned to. Fixed in the API with a regression test; nothing re-approved. |
| 2026-11-02 | same, with both fixes                   | **47 of 47 match** (PASS) | `pnpm ui:visual`, 12 tests passed, retries 0.                                                                                                                                                                                                                                                                                                                                                    |
