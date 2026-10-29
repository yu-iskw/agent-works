# P0 workbench progress

Source prompt: `/Users/yu/orca-prompts/agent-works-p0/prompt.md`. Resume from here after
compaction or restart.

## Environment notes (agent sandbox)

- Docker works through `~/.rd/docker.sock`, but the docker CLI itself stays sandboxed. It
  cannot write `~/.docker/buildx` (set `BUILDX_CONFIG=$TMPDIR/buildx`) and cannot send a build
  context containing `.env.example` or `**/credentials*` files. So images never `COPY` the
  repo. `compose.p0.yaml` has a one-shot `builder` service that compiles from a read-only
  bind mount into the `p0-app` volume (same pattern as `compose.yaml`'s `bootstrap`).
- Host `pnpm build`/`pnpm test` cannot read `credentials*.ts`; run them in the toolbox:
  `docker compose -f compose.p0.yaml run --rm -T toolbox sh -c 'pnpm test'`.
- Host port binding is denied; Playwright must run in a container on the compose network.
- The host shell exports `GOOGLE_CLOUD_LOCATION=us-central1`. Compose therefore reads
  `AW_P0_*` override names, not the bare Google names, so host env cannot leak in.

## Model discovery (2026-10-29)

From a container with ADC mounted read-only, `GET v1beta1/publishers/google/models` listed
`publishers/google/models/gemini-3.8-flash`; `GET .../gemini-3.8-flash` → 200, launch stage
`GA`. `gemini-3.8-flash-preview` → 404. In `us-central1` the model returns 404 (observed via
the leak above); in `global` it works. **VERTEX_MODEL_ID = `gemini-3.8-flash`.**

## Compose ADC proof (2026-10-29)

Command: `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f compose.p0.yaml up --build -d --wait`
→ builder exited 0; postgres, fake-directory, api, web, fake-iap healthy.

Inside `api` (`docker compose -f compose.p0.yaml exec -T api ...`):

- uid 501, `HOME=/home/app`, `CLOUDSDK_CONFIG=/home/app/.config/gcloud`,
  `GOOGLE_APPLICATION_CREDENTIALS=/home/app/.config/gcloud/application_default_credentials.json`.
- ADC readable; `touch` in the mount → `Read-only file system`.
- `docker inspect aw-p0-api-1` mounts: volume `/app` ro, bind `/home/app/.config/gcloud` ro.
- `web`, `fake-iap`, `fake-directory`, `postgres`: ADC path absent.
- `node apps/api/dist/workbench/vertex-smoke.js` →
  `{"ok":true,"at":"2026-10-29T07:31:35.747Z","project":"ubie-yu-sandbox","location":"global","configuredModel":"gemini-3.8-flash","modelVersion":"gemini-3.8-flash","responseId":"Vfbiauu1HKOLx9gPqtXC8Q4","latencyMs":2697,"finishReason":"STOP","reply":"ok"}`
- `docker compose -f compose.p0.yaml logs | grep -ciE 'ya29\.|refresh_token|private_key|client_secret|Bearer '` → 0.

## Real Vertex call budget

Used: **13 / 200** (final). Concurrency 1.

| #   | When (UTC) | Where                                   | Result                                   |
| --- | ---------- | --------------------------------------- | ---------------------------------------- |
| 1   | 07:2x      | ad-hoc container probe, global          | 200, 2619 ms                             |
| 2   | 07:30      | api smoke, us-central1 (host env leak)  | 404 model_not_found                      |
| 3   | 07:31      | api smoke, global                       | 200, 2697 ms                             |
| 4   | 08:1x      | `p0-e2e all` smoke                      | `timeout` (60 s; not reproduced since)   |
| 5   | 08:21      | manual smoke                            | 200, 1616 ms                             |
| 6   | 08:24      | `p0-e2e real` smoke                     | 200, 1875 ms                             |
| 7   | 08:24      | `p0-e2e real` flagship                  | 200, 7122 ms                             |
| 8   | 08:32      | `p0-e2e real` smoke                     | 200, 2206 ms                             |
| 9   | 08:32      | `p0-e2e real` flagship                  | 200, 20897 ms                            |
| 10  | 09:22      | `p0-e2e all` smoke (post-lint refactor) | 200, 4838 ms                             |
| 11  | 09:22      | `p0-e2e all` flagship                   | 200                                      |
| 12  | 10:36      | `p0-e2e all` smoke (final)              | 200, 2786 ms, `lCHjasexJJ6XvdAPocSzmQk`  |
| 13  | 10:36      | `p0-e2e all` flagship (final)           | 200, 19948 ms, `miHjas2rEI-Nx9gPrZ_E8AM` |

## Baseline (toolbox, before P0 changes)

- `pnpm build` 0, `pnpm typecheck` 0, `pnpm lint:eslint` 0.
- `pnpm test` on the first toolbox image: 2 failed / 2974 passed, 14 files failed, all
  needing `/usr/lib/postgresql/16/bin` or git. Toolbox now installs postgresql-16 and git
  (`dev/toolbox.Dockerfile`); rerun pending.

## Checklist

- [x] Baseline doc (`docs/p0/BASELINE.md`)
- [x] Model ID discovered: `gemini-3.8-flash` (global)
- [x] Compose stack with api-only read-only ADC; real call from inside api
- [x] Contract, migration 0017, API service/worker, Vertex + stub adapters, fixture Workspace
- [x] Web BFF, design system, client enhancement, fake IAP cookie sign-in
- [x] Playwright suites: fixture, misconfig, restart, real-llm (video)
- [x] ESLint clean (lint refactor), Prettier applied
- [x] `/code-review` (21 findings: 17 fixed, 4 dismissed with reasons) with regression tests
- [x] `/simplify` (4 reviewers, 37 findings; applied list and skips in ACCEPTANCE_REPORT.md)
- [x] Final full rerun after both: toolbox gates + `p0-e2e all` + clean `down -v` start
- [x] README, UX_REVIEW, ACCEPTANCE_REPORT (G0–G7 PASS; live Workspace pending)
- [x] Tree staged for commit; commit message and PR body handed to Orca
- [ ] Commit (GPG), push, draft PR: **done by Orca's main loop from the Mac shell**, not from this sandbox (Yu's decision)
- [ ] Run `pnpm lint && pnpm lint:security` on the Mac (Trunk cannot run in the sandbox)

## Status: READY TO COMMIT (2026-10-29)

All gates pass on the final tree. See `docs/p0/ACCEPTANCE_REPORT.md`.

## Commands

- Stack: `pnpm p0:up` (force-recreates app services so they run the latest build).
- Suites: `BUILDX_CONFIG=$TMPDIR/buildx node scripts/p0-e2e.mjs fixture|misconfig|restart|real|all`.
- Toolbox: `docker compose -f compose.p0.yaml run --rm -T --no-deps toolbox sh -c '<cmd>'`.

## Failures fixed so far

- Stale app code after rebuilds (compose does not restart dependents when only the builder
  re-runs) → `--force-recreate` of app services in `p0:up` and the suite runner.
- Builder could not delete files a previous run wrote under another UID → builder runs as
  root and skips when the source hash is unchanged.
- `initdb` failed for UID 501 (no passwd entry) → toolbox runs as `node` (1000).
- Readiness banner missing `role="alert"`; desktop hamburger visible; nested aside scroll;
  model capability caveat; grid card margin; see `docs/p0/UX_REVIEW.md`.

## Decisions

- Workspace: fixture adapter only, labelled simulated (Yu's decision).
- Runtime: `compose.p0.yaml` (new) so `compose.yaml`/`compose.dev.yml` users are unaffected.
  Entry point `http://localhost:8180` through the local-only fake IAP.
- Legacy `/v1/ask` fakes (drive, llm) are not in the P0 stack; their URLs are `.invalid`.
- Subagent models: the repo's Grok role sheet is not selectable in Claude Code; work stays
  in the main session.
