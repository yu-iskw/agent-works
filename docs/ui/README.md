# UI milestone: running and verifying the conversation workspace

The binding contract is [`reference/IMPLEMENTATION_PROMPT.md`](reference/IMPLEMENTATION_PROMPT.md); the design is [`ARCHITECTURE.md`](ARCHITECTURE.md); the gate ledger is [`ACCEPTANCE_REPORT.md`](ACCEPTANCE_REPORT.md). This page is the operator's manual: how to start the stack, what each command does, how the real model is set up, and how to recover.

## What is real and what is simulated

| Concern                | Mode                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Model                  | Real Vertex AI `gemini-3.8-flash`, location `global`, from `api-alpha` and `api-beta` only. No scripted, stub or replayed model. |
| Identity               | Simulated. Mock members `alice@local.test` and `bob@local.test`; the sign-in page says so.                                       |
| Sources                | Simulated. Fixture files from the repository, labelled as demo sources.                                                          |
| Google Docs publishing | Simulated. The fixture document store; no live write.                                                                            |
| Databases and ledger   | Real and persistent: the `aw-m1-local` Postgres volumes, which also hold every model call ever made on that stack.               |

Every `pnpm ui:*` command pins `LLM_MODE=vertex`. Exporting `AW_M1_LLM_MODE` with any other value makes the command exit before touching Compose; there is no downgrade to the scripted UI review mode that M1 keeps for itself (`pnpm m1:ux`).

## Startup

1. One-time: `gcloud auth application-default login`. Plain `gcloud auth login` is not ADC. The file it writes (`~/.config/gcloud/application_default_credentials.json`, or `GCLOUD_CONFIG_DIR`) is bind-mounted read-only into the two segment APIs and nowhere else. Nothing copies it.
2. `pnpm ui:doctor`. Every line must read `PASS` or `SKIP`; the `SKIP` lines disappear once the stack is up.
3. `pnpm ui:up`. Builds the app into the `m1-app` volume, applies migrations, starts both segments and `web`, and waits for health. Open `http://127.0.0.1:8281`.
4. `pnpm ui:doctor` again. It now reads the campaign allowance from each segment database and checks the running containers carry the UI environment.

Optional host overrides are listed in [`ui.env.example`](ui.env.example). None is a secret and none is required.

## Commands

| Command                                               | Does                                                                                                                                                                                                                                                                                                                                                                                   | Model calls                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `pnpm ui:doctor`                                      | Docker reachable; `compose config` expands with the ADC bind on `api-alpha` and `api-beta` only; ADC file exists on the host (never read); configured model, location and project; running containers match the UI env; campaign allowance per segment; the credential checks below. Writes `artifacts/ui/doctor.json`.                                                                | 0                                              |
| `pnpm ui:doctor -- --vertex`                          | The above plus one bounded smoke call per segment through the product's own gate and ledger, reporting the served model version and latency.                                                                                                                                                                                                                                           | 2                                              |
| `pnpm ui:up`                                          | Build, migrate, start both segments, wait for health. Reuses project `aw-m1-local` and its volumes.                                                                                                                                                                                                                                                                                    | 0                                              |
| `pnpm ui:down`                                        | Stop the stack. Data, keys and the ledger stay.                                                                                                                                                                                                                                                                                                                                        | 0                                              |
| `pnpm ui:restart`                                     | Runs `e2e/ui/restart/before.spec.ts` (starts real parallel work and types a draft), kills `api-alpha` while an assignment runs, stops everything, starts again, verifies health, then runs `after.spec.ts` in the same browser state: the work resumes once through lease recovery, nothing is duplicated, the conversation and the draft survive. Writes `artifacts/ui/restart.json`. | about 4 (the interrupted call is rerun)        |
| `pnpm ui:test`                                        | In the toolbox container: `pnpm install --frozen-lockfile`, build, typecheck, ESLint, Vitest. ESLint runs one top-level directory at a time (`apps/web`, `apps/api`, `packages`, `e2e`, `scripts`, then the rest) with a 3 GB heap, because the whole repository at once exhausts the 6 GB VM; any chunk with an error fails the gate. Writes `artifacts/ui/test.json`.                | 0                                              |
| `pnpm ui:e2e -- focused`                              | Browser cases against seeded rows and persisted journey results. Refuses to start unless the running stack is on the real model. `recovery.spec.ts` is the exception: answering a question, proceeding past a failed contribution and the cancelled task run real work (about five calls).                                                                                             | about 5 (`recovery.spec.ts` only)              |
| `pnpm ui:e2e -- journeys`                             | The six real-model journeys with video. Same refusal.                                                                                                                                                                                                                                                                                                                                  | yes, bounded by the cap                        |
| `pnpm ui:visual`                                      | Captures carol's reserved workspace to `artifacts/ui/screenshots/` and compares only against `artifacts/ui/baselines/approved/`. The first run on a fresh stack generates carol's reviewed task (about 10 calls). Reports `PENDING` until a human approves; never writes an approved file.                                                                                             | 0 unless a capture needs generated content     |
| `pnpm ui:contact-sheet`                               | Freezes the current captures into `artifacts/ui/baselines/candidate-<date>/` with a sha256 manifest and writes `artifacts/ui/contact-sheet.html` for review. Never writes an approved file.                                                                                                                                                                                            | 0                                              |
| `pnpm ui:evidence`                                    | Indexes videos, screenshots and results into `artifacts/ui/evidence-index.md` and `evidence.json` with build sha, model mode, source mode and timestamps, and refuses to index results that contain cookies or tokens. `-- --run` runs the journeys first.                                                                                                                             | 0 (`--run`: yes)                               |
| `pnpm ui:verify`                                      | Test, up, real-model prerequisites, focused, journeys, restart, visual, and the human gates copied from their documents. Writes `artifacts/ui/verify.json`. Non-zero on any failed mandatory machine gate or missing model prerequisite. `-- --with-smoke` adds the two smoke calls.                                                                                                   | journeys plus restart                          |
| `pnpm ui:seed-review -- --member=bob`                 | Adds the starter teammates for a usability reviewer in both segments, as that member, through the web app. Idempotent.                                                                                                                                                                                                                                                                 | 0                                              |
| `pnpm ui:seed-review -- --member=bob --with-approval` | The above, then `e2e/ui/seed/` with real Gemini as that member: a finished research task with an open publication approval in alpha, and finished work on no-shows in beta, for usability tasks 4 and 5. Skips what the member already has, and prints the calls spent per segment.                                                                                                    | 8 the first time (4 per segment), 0 on a rerun |

Direct form: `node scripts/ui/run.mjs <command> [args]`. There is no reset command. Deleting `aw-m1-local` volumes deletes the ledger, and this milestone creates no test resources of its own to clean up.

## Credential checks (U22)

`pnpm ui:doctor` proves the ADC file stays inside its two read-only bind mounts and that no secret reaches a surface a reviewer might share:

| Check                                                 | How                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| image carries no ADC file                             | `docker run --rm aw-m1:local find / -name application_default_credentials.json` with no mounts; must print nothing.                                |
| image history names no credential path                | `docker history --no-trunc aw-m1:local` has no layer mentioning `gcloud` or the ADC path.                                                          |
| web, e2e, builder, toolbox and databases mount no ADC | The expanded Compose model binds the gcloud directory on `api-alpha` and `api-beta` only.                                                          |
| container logs carry no credential field              | `docker compose logs api-alpha api-beta web` has no line with `refresh_token`, `private_key` or `client_secret`.                                   |
| running web container has no ADC mount                | `docker inspect` of the web container lists no gcloud destination.                                                                                 |
| evidence tree carries no credential field             | Every text file under `artifacts/ui` (results, reports, records) is scanned for the same field names.                                              |
| workspace CSP                                         | The web responses carry `script-src 'self'` with no `unsafe-inline`; `e2e/ui/focused/security.spec.ts` repeats this for signed-in workspace pages. |

Only names are ever printed, never values.

## Real-model setup

- Project and location come from `AW_M1_GOOGLE_CLOUD_PROJECT` (default `ubie-yu-sandbox`) and `AW_M1_GOOGLE_CLOUD_LOCATION` (default `global`). `gemini-3.8-flash` is served from `global`.
- The ADC identity needs `roles/aiplatform.user` on that project, and `aiplatform.googleapis.com` must be enabled.
- The doctor checks the file exists and the mount expands; the smoke (`--vertex`) is the only check that proves the model answers, and it costs one call per segment. The runner records the served model version from the response and refuses another model family.
- Browser suites read `LLM_MODE`, `VERTEX_MODEL_ID`, `AW_MODEL_CAMPAIGN` and the ADC presence from the running containers before starting and exit non-zero on any mismatch.

## Budget and campaign

The ledger is `wb_model_calls` in each segment database. Migration `0020` adds a nullable `campaign` column; rows from before this milestone stay `null` and keep their history. The UI commands run every container with `AW_MODEL_CAMPAIGN=ui-2026-10` and `AW_MAX_MODEL_CALLS=300`, so the gate counts only this campaign's sent Vertex calls, per segment: 300 for alpha and 300 for beta, 600 in total. Retries are rows too, so they count. Concurrency is 2 per segment and real-model suites run one segment at a time.

`pnpm ui:doctor` prints `<used> of 300 used under ui-2026-10, <remaining> remaining` per segment, from `select count(*) from wb_model_calls where mode = 'vertex' and sent and campaign = 'ui-2026-10'`. When the stack still runs an older build, it reports that migration `0020` is not applied and tells you to run `pnpm ui:up`. The cap is never raised by any script.

## Rollback and recovery

| Situation                                   | Do                                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop for the day                            | `pnpm ui:down`. Volumes (databases, keys, built app, ledger) stay. `pnpm ui:up` resumes with the same data.                                                                                              |
| A segment API died                          | `pnpm ui:restart`. Leases expire and the worker resumes unfinished assignments once; the restart spec checks nothing is duplicated.                                                                      |
| Go back to the M1 pages                     | `pnpm m1:up` starts the same project with M1's own cap (100) and no campaign. The ledger rows written under the UI campaign stay and are not counted by M1.                                              |
| Suspect the built app is stale              | `pnpm ui:up` recreates services; the builder rebuilds when the source hash changed. `docker volume rm aw-m1-local_m1-app` (stack down) forces a full rebuild and loses nothing else.                     |
| Restore after an accidental volume deletion | There is no backup in this milestone. The ledger count for the campaign restarts at 0 and the operator must account for the spent calls by hand. Avoid `docker compose down --volumes` on `aw-m1-local`. |

## Troubleshooting

| Symptom                                 | Fix                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ADC file present on host: FAIL`        | `gcloud auth application-default login`, then `pnpm ui:up`.                                                                             |
| Model `adc_unavailable`                 | Same as above; the file expired or lives in another `GCLOUD_CONFIG_DIR`.                                                                |
| `api_disabled`                          | Enable `aiplatform.googleapis.com` on the configured project.                                                                           |
| `permission_denied`                     | Grant `roles/aiplatform.user` to the ADC identity on the project.                                                                       |
| `model_not_found`                       | Location must be `global`. Changing the model is a decision for the operator; the runner refuses a substitute.                          |
| `rate_limited`                          | Quota. Wait and retry; the retry counts.                                                                                                |
| `timeout` or `unreachable`              | Retry the task; check the container can reach `aiplatform.googleapis.com`.                                                              |
| `budget_exhausted`                      | The 300-call campaign cap for that segment is reached. Raising it is an operator decision.                                              |
| `wb_model_calls has no campaign column` | The running stack predates this branch. `pnpm ui:up` applies migration `0020`.                                                          |
| `Refusing to run browser tests`         | The running containers are not on `LLM_MODE=vertex`, `gemini-3.8-flash` and campaign `ui-2026-10`. `pnpm ui:up` from this branch.       |
| `UI commands refuse AW_M1_LLM_MODE=...` | Unset it. Scripted mode belongs to `pnpm m1:ux` only.                                                                                   |
| Toolbox fails with missing modules      | Another `pnpm install` is running in the same volumes; wait and retry.                                                                  |
| ADC unreadable on Linux                 | The scripts pass `HOST_UID`/`HOST_GID`; export them when running Compose by hand.                                                       |
| `pnpm ui:visual` says PENDING           | Expected until a human copies reviewed captures into `artifacts/ui/baselines/approved/` and records the approval in `VISUAL_REVIEW.md`. |

## Evidence and privacy

All host-side output lives under `artifacts/ui/` (gitignored): `doctor.json`, `test.json`, `results-<suite>.json`, `report-<suite>/`, `test-results/<suite>/` (videos and traces), `screenshots/`, `baselines/approved/`, `visual.json`, `restart.json`, `evidence.json`, `evidence-index.md`, `verify.json`. Nothing writes media into a tracked path. The evidence manifest records paths, sizes and timestamps only; it never embeds results content, and it exits non-zero when a results file contains a cookie, token or ADC field.

## Human gates

`pnpm ui:verify` copies two statuses from documents and never sets them:

- U18 visual baseline approval: the `Status:` line in [`VISUAL_REVIEW.md`](VISUAL_REVIEW.md).
- U20 usability: the `Status:` line in [`UX_REVIEW.md`](UX_REVIEW.md).

## Workspace controls

The workspace has three regions: the sidebar, the conversation and a review panel that opens only when you open something. Below 1024 px the panel replaces the conversation and shows **Back to conversation**. Below 640 px one surface shows at a time and the sidebar is a sheet behind the menu button.

| Where        | Control                                                   | What it does                                                                                                                              |
| ------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Composer     | Enter                                                     | Sends. Shift+Enter adds a new line. Enter during an input-method composition never sends.                                                 |
| Composer     | Ctrl/Cmd+Enter                                            | Sends when the send key preference is Ctrl/Cmd+Enter; Enter then adds a new line.                                                         |
| Composer     | `+`                                                       | Attach a file, create a task, ask the coordinator for a plan, add a source.                                                               |
| Composer     | `@` at a word start                                       | Teammates and sources you may use in this segment.                                                                                        |
| Composer     | `/` at the start of a line                                | Skills attached to this teammate, and the supported commands (`/task`, `/plan`, and `/revise`, `/answer`, `/ask` when there is a target). |
| Menus        | Arrow keys, Home, End, Enter or Tab, Escape               | Move, pick, close. Escape returns focus to where you were.                                                                                |
| Chips        | Remove button, or Backspace at the start of the text      | Removes a file, teammate, skill or source from the pending message. Removed files are not sent.                                           |
| Target chip  | Change                                                    | Chooses whether the message replies to the teammate, answers a question, or revises or asks about a result.                               |
| Timeline     | Show earlier messages                                     | Loads the previous page of a long conversation and keeps the message you were reading in place.                                           |
| Panel        | Separator drag, or arrow keys (16 px), Home, End          | Resizes the panel. The width is clamped to the window and remembered.                                                                     |
| Panel        | Expand, Restore, Close, Escape, browser Back              | Reading mode and closing. Your conversation scroll and draft are kept.                                                                    |
| Result panel | Result, Sources, Changes; revision menu; `[E1]` citations | A citation opens the exact source passage; **Back to result** returns to where you were reading.                                          |

Opening a conversation marks its messages read. It never answers a question, approves a plan or authorizes a write; those happen only through their own buttons.

Publishing a result: the result panel of the latest revision offers **Publish to demo document store** (a Google Doc on a live stack). It prepares an approval and opens it; nothing is written until **Approve once**. The approval names the account, the destination, the exact revision and the full content. It is refused for an older revision, a read-only member, a result owner without an effective `docs.publish` capability, a revision that already produced a document, or while another approval is pending. An approval for a revision that a newer one replaced, or one that expired, is shown as invalid and the segment refuses it (`stale_revision`, `approval_expired`). A question can be answered from the question card or from the task panel the inbox opens; both requeue the same assignment. A failed contribution offers **Retry them** or **Proceed with what finished**; the result then lists the missing contribution under its limitations.

Files: text, Markdown, CSV and JSON up to 200 KB each, five per message. They become cited evidence for tasks and are read as untrusted data. PDF and images are refused with an explanation.

## Settings and preferences

Preferences belong to the member, not to a teammate, and live in the web database (`m1_preferences`). Signing out keeps them; it clears unsent drafts in the browser.

| Setting      | Choices                                               | Default                                                                                                                                                       |
| ------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Appearance   | System, Light, Dark                                   | System. The server applies a manual choice to the first HTML, so there is no flash.                                                                           |
| Startup view | Last conversation, Attention inbox, Coordinator recap | Last conversation. If that teammate is gone, the first teammate opens with a notice. The recap is built from current inbox and task state and calls no model. |
| Send key     | Enter, Ctrl/Cmd+Enter                                 | Enter                                                                                                                                                         |
| Panel width  | Set by resizing                                       | Clamped to the window.                                                                                                                                        |

Teammate appearance (avatar, display name, role label, accent) is edited in the teammate's details and changes only your copy of that teammate. It never changes the curated template, another member's teammate or any capability.
