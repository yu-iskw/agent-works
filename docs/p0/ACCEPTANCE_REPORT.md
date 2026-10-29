# P0 acceptance report

Date: 2026-10-29. Branch `yu-iskw/p0-workbench`, uncommitted working tree on top of `0e2d565`
(the commit is made outside the agent sandbox, which cannot use GPG). Environment: macOS host,
Rancher Desktop (Docker 29.5.3, Compose v5.3.1), Node 24.13.0 and pnpm 11.0.5 inside containers,
Playwright 1.63.0 image, Vertex AI project `ubie-yu-sandbox`, location `global`.

| Gate                           | Result                         | Basis                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 Reproducibility             | **PASS**                       | From zero `aw-p0` volumes, `pnpm p0:up` built and reached all-healthy in 54 s; every service healthcheck green; restart suite proves history survives a restart of every service including Postgres; no credentials in images (runtime image is Node + pnpm only) or in git.                                                                                                             |
| G1 Real-model proof            | **PASS**                       | `gemini-3.8-flash` (publisher model, GA) discovered in `global`; dedicated smoke inside `api` and the real-llm browser flagship both called Vertex and asserted `mode=vertex`, model version and response ID.                                                                                                                                                                            |
| G2 Functional P0               | **PASS** (Workspace simulated) | Prompt → persisted events → fixture Drive evidence → real Gemini draft → contextual approval → exactly one simulated Docs write → durable completed task. **Live Google Drive/Docs: pending, not claimed.**                                                                                                                                                                              |
| G3 Automated coverage          | **PASS**                       | All required browser cases pass with 0 skipped, 0 flaky, `forbidOnly`; unit/integration, lint, typecheck, build pass. Trunk itself cannot run in the agent sandbox (see Limitations); its ESLint and Prettier checks were run directly and pass.                                                                                                                                         |
| G4 Security and data integrity | **PASS**                       | No known critical/high finding open in the implemented flow after `/code-review` (21 findings, 17 fixed, 4 dismissed with reasons). Negative tests cover owner isolation, CSRF, stale/replayed approvals, idempotency, XSS and unsafe links. Dependency CVE scan (`pnpm lint:security`) could not run in the sandbox; see Remaining risks.                                               |
| G5 Accessibility/responsive    | **PASS**                       | axe: 0 critical/serious on 9 screens; keyboard-only flagship passes; 375/768/1440 with no horizontal overflow; status announcements and reduced motion verified.                                                                                                                                                                                                                         |
| G6 Visual polish and evidence  | **PASS**                       | 26 screenshots captured by the suites (local, not committed), a playable real-model flagship video (recorded locally by the real suite, not committed), a passing local visual regression suite with reviewed baselines (local-only by Yu's decision; not committed, not run in CI), and a human review checklist in `UX_REVIEW.md`. Subjective quality still needs the human checklist. |
| G7 Documentation and handoff   | **PASS**                       | `docs/p0/README.md`, `BASELINE.md`, `PROGRESS.md`, `UX_REVIEW.md`, this report.                                                                                                                                                                                                                                                                                                          |

## Final run (after code review and /simplify)

| Command                                                                              | Result                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `docker compose -f compose.p0.yaml run --rm -T --no-deps toolbox sh -c 'pnpm build'` | exit 0                                                                                                           |
| `… 'pnpm typecheck'` and `… '(cd apps/web && npx tsc --noEmit -p client)'`           | exit 0, exit 0                                                                                                   |
| `… 'pnpm lint:eslint'`                                                               | 0 errors, 3 warnings (non-literal RegExp ×2, AxeBuilder default import)                                          |
| `… 'pnpm test'`                                                                      | 267 files passed, 4 skipped; **3139 tests passed**, 98 skipped (pre-existing skips outside P0)                   |
| `pnpm knip` (host)                                                                   | clean except sandbox noise: the 5 `credentials*` files and 33 imports of them are unreadable to the host process |
| `npx prettier --write` on every changed file (toolbox)                               | applied, no diff after                                                                                           |
| `node scripts/p0-e2e.mjs all`                                                        | `{"fixture":"pass","misconfig":"pass","restart":"pass","real":"pass"}`                                           |
| `docker compose -f compose.p0.yaml down -v && pnpm p0:up`                            | all 5 long-running services healthy, builder exit 0, 54 s                                                        |

Playwright results (`artifacts/p0/results-*.json`):

| Suite                          | Expected | Unexpected | Flaky | Skipped |
| ------------------------------ | -------- | ---------- | ----- | ------- |
| fixture                        | 33       | 0          | 0     | 0       |
| misconfig                      | 1        | 0          | 0     | 0       |
| restart-before / restart-after | 1 / 1    | 0          | 0     | 0       |
| real-llm                       | 2        | 0          | 0     | 0       |

### Coverage of the required browser cases

| #   | Case                                                                                    | Test                                                                                                          |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Clean launch, healthchecks, no console errors                                           | `flow.spec` "stack is healthy…"; G0 clean run above                                                           |
| 2   | Readiness and missing Vertex config                                                     | `misconfig/readiness.spec`; Connections in `a11y.spec`                                                        |
| 3   | Keyboard create, validation, duplicate prevention, progress, result                     | `flow.spec` "creates a task from the keyboard…", "server rejects an empty objective…", "shows real progress…" |
| 4   | Real Gemini with model metadata                                                         | `real-llm/flagship.spec` (both tests) + `vertex-smoke`                                                        |
| 5   | Evidence cards, safe links, citations match records                                     | `flow.spec` "citations match recorded evidence…"; `security.spec` injection test                              |
| 6   | Approval context, reject no write, approve one write, stale/replay                      | `flow.spec` "reject writes nothing…", "stale and replayed approvals…"                                         |
| 7   | Draft, result link, refresh and restart survival, no duplicate on retry                 | `flow.spec` history test; `restart/*`; `errors.spec` retry and reconcile tests                                |
| 8   | History and owner isolation incl. direct URL/API                                        | `security.spec` "a second identity cannot see or act…"                                                        |
| 9   | Vertex unavailable, rate limit, timeout, Drive denied, empty, action failure, uncertain | `errors.spec` (7 tests)                                                                                       |
| 10  | 375×812, 768×1024, 1440×900                                                             | `a11y.spec` responsive ×3                                                                                     |
| 11  | Keyboard-only, accessible names, axe, reduced motion                                    | `a11y.spec`                                                                                                   |
| 12  | XSS, untrusted Markdown, dangerous URLs, CSRF, stale approval, authz                    | `security.spec`, `flow.spec` stale test, web unit tests                                                       |

## Real Vertex evidence (sanitised)

- Model discovery: `GET v1beta1/publishers/google/models/gemini-3.8-flash` → 200, launch stage GA;
  `gemini-3.8-flash-preview` → 404; the model returns 404 in `us-central1`.
- Smoke (`artifacts/p0/vertex-smoke.json`): `{"ok":true,"mode":"vertex","attempts":1,"at":"2026-10-29T10:36:07.017Z","configuredModel":"gemini-3.8-flash","modelVersion":"gemini-3.8-flash","responseId":"lCHjasexJJ6XvdAPocSzmQk","latencyMs":2786,"finishReason":"STOP"}`
- Flagship (`artifacts/p0/real-llm-evidence.json`): task `ee2d7327-eb5f-46da-a81c-589a67a0bea7`,
  `mode` vertex, `modelVersion` gemini-3.8-flash, `responseId` `miHjas2rEI-Nx9gPrZ_E8AM`,
  latency 19948 ms, exactly one `wb_model_calls` row, exactly one simulated document.
- Budget: **13 of 200** real calls used in total this session (ledger in `PROGRESS.md`),
  concurrency 1.

## Artifacts

- Screenshots: written to `artifacts/p0/screenshots/` by every suite run (`01`–`14` fixture states at 375/768/1280/1440, `20`–`25` real model; GCP project ID masked). They are gitignored and no CI workflow uploads them; rerun `node scripts/p0-e2e.mjs all` to regenerate.
- Video: `node scripts/p0-e2e.mjs real` records the flagship flow (prompt → real Gemini → evidence → approval → simulated doc) to `artifacts/p0/videos/flagship-real-gemini.webm`. Gitignored and not uploaded by any CI workflow.
- Visual baselines: local-only by Yu's decision. `e2e/p0/__screenshots__/` is gitignored; `scripts/p0-e2e.mjs fixture` generates them on a checkout that has none, and CI skips `visual.spec.ts` (`GITHUB_ACTIONS=true`). Regeneration command in `README.md`. The 6 local baselines were reviewed.
- Results: `artifacts/p0/results-{fixture,misconfig,restart-before,restart-after,real-llm}.json`.

## Review rounds

`/code-review` (high) on the full branch diff returned 21 findings. Fixed: poison task re-claim
loop (quarantine to `failed`/`outcome_uncertain`), workbench now opt-in in the api
(`WORKBENCH_ENABLED`), expired approval now fails the task so Retry re-drafts, NaN budget fails
closed, readiness filtered by mode/model, "may" month false match, ambient ADC readiness,
composer keeps text on create failure, budget counts only requests actually sent (`sent`
column), duplicate-citation count, two-source rule for recurring causes, poller refuses
non-fragment responses, complete conflict messages, write retry resets action status, lease
token, no-op model gate removed, `npx` replaced. Dismissed: CSRF helper reuse (different
origin policy), prefix mount vs slot registry (sub-router by design), default project (Yu's
binding decision, overridable), idle poll load (resolved by the opt-in flag). Regression
tests were added for each P1.

`/simplify` (reuse, simplification, efficiency, altitude) produced 37 findings. Applied: shared
report-section model and one URL policy in `packages/domain`, worker on `createScheduleWorker`,
`Caller.email` from the verified token, parallel BFF fetches and a `pendingApprovals` count in
readiness, ETag'd assets, smaller command responses, bulk evidence insert, `applyMigration`
reuse, fake IAP forwarding all non-hop headers, `views.tsx` split, unused exports removed,
stub reads structured evidence and its fault markers are gated. Skipped with reasons: reusing
the broker approval store (different claim contract and self-approval semantics), Vertex zod
schema reuse (thought parts), a shared JSON-body helper (would migrate nine unrelated callers),
304 polling, optional legacy `/v1/ask` config (outside P0).

## CI round 1 (PR #177 at 19a7d49)

| Failing job            | Root cause                                                                                                                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trunk Check            | Two `security/detect-non-literal-regexp` hits (`routes.ts`, `e2e/p0/helpers.ts`), a named-as-default import, quoted `user:` values, `dev/p0/build.sh` not shfmt-formatted, Dockerfiles without a non-root `USER` / `HEALTHCHECK`, and Prettier on machine-written `artifacts/p0/*.json` | Literal route regexes; string name match in the helper; named `AxeBuilder` import; `user: root/node/ubuntu` (same UIDs, no YAML 1.1 ambiguity); shfmt 3.6.0 applied; `USER node` and `HEALTHCHECK NONE`. Generated `artifacts/p0/*.json` is excluded from Prettier only (`.trunk/trunk.yaml`, `.prettierignore`) because every suite run rewrites it. |
| Generate and scan SBOM | Same Dockerfile findings, plus OSV advisories published 2026-10-20/21 against `vite@8.0.16` (launch-editor, fs.allow), `zod@4.6.5` (GHSA-mrhx-c7xc-m3w5, high) and `vitest`/`@vitest/mocker@4.1.11`. Main carries the same versions.                                                    | `vite` → 8.3.5, `vitest` and `@vitest/coverage-v8` → 4.1.12, `zod` → 4.6.7 in every manifest, and a `zod: 4.6.7` override because `@google/adk` and `knip` otherwise keep 4.6.5. All versions are past the 7-day release-age quarantine.                                                                                                              |
| e2e-security           | `e2e/playwright.config.ts` makes one project per `e2e/` directory, so `e2e/p0` became a project and the job's `security` path filter picked up `e2e/p0/fixture/security.spec.ts`, which needs the P0 stack                                                                              | `p0` excluded from the generic project list like `adversarial`; it runs through `e2e/p0/playwright.config.ts` and `scripts/p0-e2e.mjs`. The job still runs the same 12 existing security tests (`--list` before: 16 incl. 4 P0, after: 12).                                                                                                           |

Verified locally with the CI tools in containers: yamllint 1.38.0 on `compose.p0.yaml` clean,
Trivy 0.72.0 config scan of `dev/` 0 HIGH/CRITICAL, OSV-scanner 2.4.0 on `pnpm-lock.yaml` "No
issues found", shfmt 3.6.0 diff clean, Prettier 3.9.6 `--check` on every changed file clean,
ESLint `--max-warnings 0` on the P0 code clean.

Media policy (Yu): screenshots, videos and visual baselines are no longer committed. With the
baselines moved away, `node scripts/p0-e2e.mjs fixture` regenerated 6 baselines (5 tests) and
then passed 33/33; with `GITHUB_ACTIONS=true` the fixture project lists 28 tests and no visual
spec. The full `p0-e2e all` run before this change passed (fixture, misconfig, restart, real).

## Security and local-only safeguards

See `README.md` "Security assumptions". In short: the fake IAP is trusted only through
`compose.p0.yaml`'s issuer and JWKS URL; cookie sign-in needs `FAKE_IAP_SIGN_IN=1`; the api
and web only expose the workbench with `WORKBENCH_ENABLED=1` / `WEB_WORKBENCH=1`; every query
is owner-scoped and other owners get 404; writes need a captured approval and an idempotency
key; CSP forbids inline script; ADC is a read-only mount on `api` only and logs carry no tokens
(`docker compose logs | grep -ciE 'ya29\.|refresh_token|private_key|client_secret|Bearer '` → 0).

## Limitations and remaining risks

- **Live Workspace is not implemented.** Drive and Docs are fixtures; OAuth consent and the
  `drive.file` write scope are future work.
- **Trunk itself cannot run in the agent sandbox** (host: telemetry and crash reporter blocked;
  container: worktree resolves to a lowercased macOS path). CI runs it; locally each underlying
  tool was run directly (see CI round 1). New runtime dependency: `google-auth-library@10.9.1` (already in the lockfile
  transitively). New dev dependencies: `@axe-core/playwright@4.14.0`, `postgres@3.4.9` (root).
- One smoke call timed out once (60 s) and did not reproduce in seven later calls; the smoke
  now retries once on transient codes.
- Usability is judged by an agent from screenshots, not by users. See the human checklist.
- Dark mode exists in tokens but was not captured or reviewed.
