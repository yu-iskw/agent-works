# Handoff: the UI/UX milestone after M1

M1 closed as mock-only by Yu's decision (2026-10-30). The model is real Vertex `gemini-3.8-flash`. Identity is mock, sources are fixture files, and Google and GitHub are mocked. The next milestone focuses on UI and UX before deeper integrations.

## Entry gates moved from M1 (by Yu's decision)

| Gate                 | What it needs                                                                                          | Where to start                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M17 visual baselines | Yu reviews the latest captures and approves them as baselines. Later rounds then compare against them. | `pnpm m1:ux <round>` writes screens at 375, 768 and 1440 px to `artifacts/m1/ux/round-<n>/` (gitignored). Round history is in `docs/m1/UX_ITERATIONS.md`. |
| M19 human usability  | Three real reviewers run the script and their results are recorded factually.                          | `docs/m1/UX_REVIEW.md`                                                                                                                                    |

## Known UX issues to work on

- At 375 px a finished task page is about 4,500 px tall, because the result, evidence and activity stack vertically. Options: put evidence in a drawer or tabs, or collapse activity further. Citation links (`#ev-E1`) already jump to evidence.
- The manual new-task form always shows three specialist rows. An "add specialist" control would shorten it; the form must still work without JavaScript.
- Review rounds use a scripted model, so statement text in those screenshots is canned. Judge content on the real-model suite (`pnpm m1:e2e:local`).
- After a `#decision` jump, full-page screenshots draw the sticky header partway down the image. That is a capture artifact, not a layout bug (UX round 6).
- The inbox has no paging or grouping limit. On the UX review stack, after 11 rounds of accumulated tasks, it is about 9,000 px tall at 375 px. Add paging, collapse resolved items, or cap each group.
- The Connections page in mock mode shows provider cards that cannot be used. Decide whether mock mode should hide them or keep them as a preview.

## Code follow-ups from the final M1 review

- The M1 web code duplicates P0 helpers: the BFF client `call()`, CSRF and cookie parsing, static assets, and the client script (announcer, menu, local times). Share them before the UI grows further.
- Error labels are a hand-kept map. A typed `ConflictCode` union would make tsc list missing labels.
- Connections should report `required: false` in mock mode from the API, instead of each view checking the source mode.
- The metrics scope fields are written twice, in the new-task form and the re-run form.

## Real identity and integrations, deferred to a later milestone

The code exists and is unit-tested, but none of it has run against a real provider:

- **Google sign-in** (OpenID Connect with PKCE, state and nonce, and server sessions). Yu can supply an OAuth client from another Google Cloud project. Drive API and Docs API must be enabled in that client's project. The consent screen and test users live in that project. In Testing mode, Drive refresh tokens expire after 7 days; sign-in tokens with only basic scopes do not.
- **Drive read and Docs publish** with per-member connections, the `appProperties` reconcile, and exactly-once writes (M3, M8 live overlap, M10 research, M12).
- **BigQuery live queries**: named, parameterised templates, dry run first, 10 MB cap. Out of scope by Yu's decision; M1 uses the seed CSVs.
- **GitHub**: no real OAuth App by Yu's decision; GitHub is mocked in tests. The segment API still reads `AW_M1_GITHUB_CLIENT_ID` and `AW_M1_GITHUB_CLIENT_SECRET` as optional settings. Remove them, or wire them up, when that decision is revisited.
- **Live tooling**: `node scripts/m1/run.mjs up --live-stack`, `doctor --live-stack`, `pnpm m1:e2e:live` (`e2e/m1/live/journeys.spec.ts`, never run), and the setup guides `SETUP_OAUTH.md` and `SETUP_RESOURCES.md`.
- **Three live videos (M18 as originally written)** and the credential checks with real tokens (M20).

## Budget carried over

Real Vertex calls used by M1 are recorded in `docs/m1/PROGRESS.md` and `ACCEPTANCE_REPORT.md`. The campaign cap is 600, with a pause at 550. UX rounds use the scripted model and cost no calls.
