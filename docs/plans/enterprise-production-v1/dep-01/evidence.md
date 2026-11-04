# DEP-01 evidence

Task DEP-01. Branch `epv1/dep-01-dev-deploy`. Status: READY_FOR_REVIEW (local). Live items are AWAITING_OPERATOR. Base `epv1/integration`; result SHA is the commit that carries this file.

## Scope notes

- Write set follows the coordinator, which adds `docs/runbooks/deploy-dev.md` to #24's exclusive paths and allows `.github/workflows/deploy-dev.yml`. New helper files `e2e/dev/validate-deploy-inputs.mjs`, `e2e/dev/deploy-binding.ts` and `e2e/dev/deploy-workflow.test.ts` stay under `e2e/dev/**`. #25's `e2e/dev/workflow-cloud.spec.ts` is untouched and still excluded from the dev config.
- No migration. No applied migration edited.

## Acceptance mapping

| Criterion                                 | Check                                                                                                                                                                      | Result                | Kind  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----- |
| Reject absent dev URL                     | `playwright.dev.config.test.ts` "rejects an absent dev URL..."                                                                                                             | pass                  | local |
| Reject absent/placeholder identities      | same file, `it.each` empty, `<...>`, `${...}`, placeholder word, too short, plus identical tokens and same-subject JWTs                                                    | pass                  | local |
| Reject fake fallback                      | `AW_DEV_STACK`, `AW_FAKE_USER`, `AW_FAKE_IAP_URL` refuse; localhost, loopback, IP, http refused                                                                            | pass                  | local |
| Bind to approved SHA and digest           | `deploy-binding.ts` via config tests (wrong SHA, tag-pinned, non-dev, missing approvalRef, URL not the recorded aw-web url); `deploy-workflow.test.ts` for workflow inputs | pass                  | local |
| Digest pinned, not tag                    | `validate-deploy-inputs.mjs` tests (tag, tag plus digest, short, uppercase, foreign registry, other project, swapped service)                                              | pass                  | local |
| Workflow stays manual, keyless, dev only  | `deploy-workflow.test.ts` contract checks; actionlint exit 0                                                                                                               | pass                  | local |
| Stale BLOCKED text fixed                  | `resolveCrossUserResourceConfig` now names `/tasks/<id>` and `/artifacts/<id>`; path shape tied to `apps/web/app/tasks/handler.ts` by a drift test                         | pass                  | local |
| Operator evidence: sign-in/ask/cite/audit | `skeleton.sign-in-ask-cite-audit`                                                                                                                                          | AWAITING_OPERATOR     | live  |
| Operator evidence: owner access           | `sec.owner-access` (new)                                                                                                                                                   | AWAITING_OPERATOR     | live  |
| Operator evidence: cross-user denial      | `sec.cross-user-leak`                                                                                                                                                      | AWAITING_OPERATOR     | live  |
| Operator evidence: direct URL denial      | `sec.direct-run-url-blocked`                                                                                                                                               | AWAITING_OPERATOR     | live  |
| Request for operator                      | `operator-approval.md`                                                                                                                                                     | drafted, not approved | doc   |

## Commands

Recorded in the final report with exit codes. Nothing live was run (no gcloud, no workflow dispatch, no Playwright against a URL).

## Gaps and risks

1. `AW_MODE=production` is not set anywhere in `infra/terraform`. The workflow now refuses to deploy until `aw-api` carries it. Owner: Terraform/FND-02 wiring.
2. "audit" evidence is indirect: replaying the ask `requestId` hits the committed reservation. aw-web exposes no audit read route.
3. Stage 1 steps outside DEP-01's files (revoked source denial, broker forged authority, stop blocks effects, restore drill) are not covered here.
4. The `aw-api` ingress annotation (`run.googleapis.com/ingress`) and the `spec.template.spec.containers[0]` shape are read from `gcloud run services describe --format=json`. Not exercised live; a first run may need an adjustment, and it fails closed.
5. FND-05 identity docs: none found in this tree to bind to; identity claims are checked only through distinct tokens.
