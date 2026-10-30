# UI milestone usability review (gate U20)

Status: **PENDING**. Yu recruits three reviewers who have not seen the implementation. Nobody on the build side coaches them during a session. Agent inspection and simulated personas do not count toward this gate.

## Before a session

The facilitator prepares the build once per review day.

1. Start the stack: `pnpm ui:up`. It builds, migrates and starts both segments, then waits for health. Real Gemini answers every conversation and task, so check the remaining allowance first with `pnpm ui:doctor`.
2. Seed the reviewer's workspace: `pnpm ui:seed-review -- --member=bob`. It creates the starter teammates and leaves the conversations empty. It spends no model calls.
3. Open `http://127.0.0.1:8281` in a fresh browser profile. Sign in as the reviewer account shown on the sign-in page (the identity is simulated; no real Google account is used).
4. Start a screen recording if the reviewer agrees. Keep recordings local under `artifacts/ui/usability/` (gitignored). Never upload them.

Tell the reviewer, word for word:

> This is a workspace where you work with AI teammates. Sources and sign-in are simulated for this test, but the teammates are real AI models. Please think aloud. I can't help you with the tasks, but you can stop at any time. We are testing the product, not you.

## Tasks

Read each task aloud and hand the reviewer a card with the same text. Start the timer when you finish reading.

| #   | Task card                                                                                                                                                                                              | Done when                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 1   | Give one of your teammates a new name, a different avatar and a different color. Then give that teammate a reusable skill.                                                                             | Name, avatar and accent show in the sidebar and header. The skill appears in the teammate's details.  |
| 2   | Ask your teammates to compare the three internal analytics tools in the demo sources and recommend one. Have at least two teammates work on it at the same time. Start the work from the conversation. | A task with two or more specialist assignments is running or finished, created from the conversation. |
| 3   | When the result is ready, open one of the sources it cites. Then ask for a substantive change to the result and compare the new version with the old one.                                              | A second revision exists and the reviewer has opened the Changes view.                                |
| 4   | Open your inbox. Deal with the item that needs you, and tell me in your own words what will happen when you confirm it.                                                                                | The item is resolved, and the stated outcome matches the real one (account, destination, revision).   |
| 5   | Switch to the other segment. Find the work about conversion rates and tell me which segment you are in and how you know.                                                                               | The correct task is open in the other segment and the reviewer names the active segment.              |

Task 4 uses a publication approval that the facilitator prepares before the session with `pnpm ui:seed-review -- --member=bob --with-approval`. That command spends real model calls, about 6, and prints how many.

## After the tasks

Ask, word for word, and write down the answer verbatim:

> Did this feel like an ongoing conversation with teammates, and where did the interface interrupt that feeling?

Then ask: "Was anything about what would happen when you approved unclear?"

## Recording sheet

Copy this block once per reviewer into the results section below.

```text
Reviewer: R<n> (role, familiarity with AI tools; no names)
Date / build: <date> / <git sha>
Theme and width used:

Task 1  completed unaided: yes/no   time: m:ss   errors:
        confusion observed:
Task 2  completed unaided: yes/no   time: m:ss   errors:
        confusion observed:
Task 3  completed unaided: yes/no   time: m:ss   errors:
        confusion observed:
Task 4  completed unaided: yes/no   time: m:ss   errors:
        stated outcome (verbatim):
        matches actual outcome: yes/no
Task 5  completed unaided: yes/no   time: m:ss   errors:
        segment named (verbatim):
        correct: yes/no

Conversation question (verbatim):
Approval clarity (verbatim):
Blockers (prevented completion or created a false belief):
```

## Pass conditions

- At least two of three reviewers complete every task unaided.
- All three correctly identify the active segment and the approval destination and content.
- No unresolved blocker prevents completion or creates a false belief about an action's outcome.

Fix every blocker, then retest the affected tasks with a reviewer and record the retest below. Do not report scores or statistics; three sessions do not support them.

## Results

None yet.
