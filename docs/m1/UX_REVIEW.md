# M1 usability review

Gate M19 needs at least three reviewers who are unfamiliar with the implementation. This file holds the script and the factual results. It contains no private task content. Results are recorded only from real sessions; nothing here is invented.

Status: **PENDING**. No reviewer sessions have run yet.

## Setup (facilitator)

1. `pnpm m1:up`, then open `http://localhost:8280` on the facilitator's machine. The reviewer can share the screen, or use the machine directly.
2. Sign the reviewer in as **member 2** (or member 1), with Google and GitHub already connected in both segments. Reviewers never see a password or token.
3. Start a screen recording only if the reviewer agrees. Recordings stay local in `artifacts/m1/ux-review/` (gitignored).
4. Read the introduction below aloud, then hand over. **Do not coach.** If the reviewer asks a question, answer "What would you try?" and note the question. Stop a task after 8 minutes and mark it not completed.

## Introduction (read aloud)

> "This is a workspace where you delegate work to AI teammates. Each teammate has a role and reusable methods called skills. The work happens in a 'segment', which is a separate workspace with its own data. I'll give you five tasks. Please think aloud. There are no wrong answers; we are testing the product, not you."

## Tasks

| #   | Task given to the reviewer                                                                                                                                                                               | Completed when                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | "In the **alpha** segment, make your own copy of the _Research analyst_ teammate, rename it to include your initials, and attach the _Evidence-first comparison_ skill to it and to one other teammate." | Private copy exists with the new name. Skill attached to two teammates. Curated original unchanged.                                              |
| 2   | "Ask your teammates to compare the feature-flag options in the alpha research folder. Either assign two of them yourself, or let the coordinator propose a plan and approve it."                         | At least two assignments run (manual), or a plan is approved and its assignments run.                                                            |
| 3   | "When the brief is ready, open the source behind one claim, then ask for a correction: the Togglr uptime figure should be treated as unresolved. Compare the new version with the old one."              | Source opened from a citation. Revision requested. Comparison view opened and the reviewer can say what changed.                                 |
| 4   | "Check your inbox and deal with whatever needs you: answer a question, decide an approval, or recover a failed item."                                                                                    | One inbox item resolved. Before approving any publish, the reviewer states the destination account, the document title and what will be written. |
| 5   | "Switch to the **beta** segment. Find the work you have there, and tell me which accounts are connected in beta."                                                                                        | Reviewer names the active segment and the connected accounts correctly, and does not mistake alpha work for beta work.                           |

After each task, ask: "On a scale you choose, how confident are you that it did what you wanted, and why?" Record the words, not a score.

## Pass conditions (from the M1 brief)

- At least two of three reviewers complete every task unaided.
- Every reviewer correctly identifies the active segment, and the exact target and content of an action before approving it.
- No unresolved blocker prevents completion or makes a reviewer misunderstand whether an external action happened.
- Observed completion, confusion, errors and timing are recorded. Blockers are fixed, and the affected tasks are rerun.

## Recording template (one per reviewer)

```text
Reviewer: R<n> (role only, no name), date, build commit
Task 1: completed yes/no, minutes, confusion observed, errors, quotes
Task 2: ...
Task 3: ...
Task 4: action target and content stated before approve? yes/no (exact words)
Task 5: active segment named correctly? yes/no; connected accounts named correctly? yes/no
Blockers found:
Fixes made (commit) and retest result:
```

## Results

None yet.

## Agent's own inspection (does not count toward M19)

Recorded separately in `ACCEPTANCE_REPORT.md` under M16 and M17.
