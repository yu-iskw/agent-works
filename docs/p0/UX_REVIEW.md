# P0 UX review

Reviewer: Claude (agent), 2026-10-29. Method: read every screenshot under
`artifacts/p0/screenshots/` at 375, 768, 1280 and 1440 px, the visual baselines in
`e2e/p0/__screenshots__/`, and the real-model video, then fix and re-capture. This is an
**automated proxy plus one agent's visual judgment**. It is not a usability study with real
users; see the human checklist at the end.

## Findings and fixes

| #   | Finding                                                                                                                                           | Evidence (before)                                | Fix                                                                                                                        | Status                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Hamburger button showed on desktop. `.btn { display:inline-flex }` came later in the cascade than `.menu-button { display:none }`.                | First stub-mode capture of the home page at 1440 | Scoped rule `.topbar .menu-button` after `.btn`; e2e asserts the button is hidden at ≥900 px                               | Fixed, covered by `responsive layout at 1440x900`                         |
| 2   | Sidebar background stopped at viewport height on long pages.                                                                                      | Full-page task capture at 1440                   | Column background drawn on `.shell`, not the sticky nav                                                                    | Fixed                                                                     |
| 3   | Sticky right aside with its own scroll hid the Approve/Reject buttons below the fold of a nested scroller.                                        | Task capture at 1440                             | Aside flows with the page; no nested scroll                                                                                | Fixed, `approve button reachable` checks in responsive and keyboard tests |
| 4   | Readiness banner had no `role="alert"`, so the "Vertex AI is not configured" state was not announced.                                             | `misconfig` suite failure                        | `role="alert"` on readiness and API-unavailable banners                                                                    | Fixed, `misconfig` suite                                                  |
| 5   | Real model added a caveat "Direct creation of Google Docs cannot be performed by this analysis step", which contradicts the approval flow.        | `24-real-report-draft-1440.png`, first real run  | System prompt says the workbench creates documents after approval; the model must not discuss it                           | Fixed; second real run gaps list only evidence limits                     |
| 6   | Element screenshots of the report scrolled under the sticky top bar, so a band overlapped the summary. The visual baselines had the same overlap. | First `24-real-report-draft-1440.png`            | `captureElement` sizes the viewport to the element; visual suite uses a tall viewport; baselines regenerated and inspected | Fixed                                                                     |
| 7   | Connections cards were misaligned: `.card + .card` margin applied inside the grid.                                                                | `13-connections-desktop-1440.png`                | `.grid-2 > .card + .card { margin-top: 0 }`                                                                                | Fixed                                                                     |
| 8   | Brand name wrapped to two lines at 768 px next to the environment badges.                                                                         | `11-task-tablet-768.png`                         | `white-space: nowrap` on brand and badges                                                                                  | Fixed                                                                     |
| 9   | Jump targets with `tabindex="-1"` (approval panel after a redirect to `#approval`) drew a double focus ring.                                      | `09-outcome-uncertain-1440.png`                  | No outline for focused non-interactive `tabindex="-1"` sections; controls keep the 3 px ring                               | Fixed                                                                     |
| 10  | Full-page captures taken after scrolling drew the sticky top bar mid-page.                                                                        | `09-outcome-uncertain-1440.png`                  | `fullShot` scrolls to top before capturing                                                                                 | Fixed (test artifact, not a product defect)                               |

## What the screens show now

- **Hierarchy.** Each task page reads top to bottom as the user's objective, the agent's
  status turn with the one action that matters now, the draft, then context: approval,
  activity and evidence. At 1440 px the context sits in a right column; below 1200 px it
  stacks under the report, with jump links (Report, Approval, Activity, Evidence).
- **Honesty labels.** "Simulated Workspace" sits in the header. "STUB MODEL" appears in the
  header, on the task and on the report in stub mode. The approval says "Simulated write".
  The created document opens on a page titled "Simulated Google Doc".
- **States.** Running uses a spinner, the latest real event and a report skeleton.
  Waiting shows an amber approval card with the exact action, destination, account, scope,
  fingerprint, expiry, content preview and risks. Failed shows a red alert with the
  classified cause, remediation and Retry. Uncertain shows an amber alert with Reconcile.
  Rejected, cancelled and completed each get a final, immutable receipt.
- **Density.** The 375 px task page is long, as expected: the full report precedes the
  approval. The agent turn's "Review approval" link and the jump links make it two taps
  away.

## Accessibility results (automated)

- axe-core (WCAG 2.0/2.1/2.2 A and AA tags) on sign-in, home, task waiting, task completed,
  task failed, simulated document, tasks, approvals and connections: **0 critical, 0
  serious** (`a11y.spec.ts`, `primary screens...`).
- Keyboard only: skip link, Tab to the objective, Ctrl+Enter, Tab to "Approve and create"
  with a visible 3 px outline, Enter, completed (`the flagship flow completes with the
keyboard alone`).
- Status announcements: one `role="status"` live region; polling announces "Task status:
  Needs approval" (`status changes are announced`).
- Reduced motion: animations collapse to near-zero duration under
  `prefers-reduced-motion: reduce` (`reduced motion disables animation`).
- Responsive: no horizontal overflow at 375×812, 768×1024 and 1440×900 on home, task,
  tasks, approvals and connections. The mobile drawer opens, closes on Escape and returns
  focus to its button.

## Unresolved limitations

- Approval appears after the full report on narrow screens. Moving it above the report on
  mobile would shorten the path. Not done; it would need a different source order.
- Long scope URLs break mid-word in the approval card at 375 px. Readable, not pretty.
- No dark-mode screenshots were reviewed. Tokens exist for `prefers-color-scheme: dark`,
  but no test or capture runs dark mode.
- Times render in the browser's locale after script loads. Without script they show UTC.

## Human review checklist (subjective quality)

Tests cannot judge these. A person should check them before calling the UI good:

- [ ] Would a new user understand, without help, that nothing is written until they approve?
- [ ] Is the difference between "Draft, not published" and "Published to Simulated Google Docs" obvious?
- [ ] Are the risk bullets useful, or do they read as boilerplate?
- [ ] Does the activity timeline feel like real progress rather than noise?
- [ ] Is the real-model report (see `24-real-report-draft-1440.png`) something an engineering manager would send?
- [ ] Do the simulated labels feel clear without being alarming?
- [ ] On a phone, is reaching Approve acceptable?
- [ ] Dark mode: does it look intentional?
