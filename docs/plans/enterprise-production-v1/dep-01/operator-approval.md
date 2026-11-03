# DEP-01 concrete operator action request (draft, not an approval)

Values in `<ANGLE_BRACKETS>` are for the operator to fill. Missing fields block execution. Agent prepared this; the operator approves and executes under repository policy. Nothing here has been run.

- **Task and reason.** DEP-01 / issue #24. Deploy an approved digest to the dev project behind IAP, then run the dev e2e suite against that exact digest to produce Stage 1 evidence for sign-in/ask/cite/audit, owner access, cross-user denial and direct URL denial.
- **Exact project/environment/region.** Environment `dev`. Project `<DEV_PROJECT_ID>` (GitHub environment variable `TF_PROJECT_ID`). Region `asia-northeast1`, hard-coded in the workflow; operator confirms it matches the Q1 region decision `<Q1_DECISION_REF>`. Services `aw-api` (internal-only ingress) and `aw-web` (IAP).
- **Source SHA / image digest / schema/config versions.**
  - SHA `<APPROVED_40_HEX_SHA>`, merged on `origin/main`.
  - `web_image` `asia-northeast1-docker.pkg.dev/<DEV_PROJECT_ID>/aw-images/aw-web@sha256:<WEB_DIGEST>`.
  - `api_image` `asia-northeast1-docker.pkg.dev/<DEV_PROJECT_ID>/aw-images/aw-api@sha256:<API_DIGEST>`.
  - Schema: highest applied migration at SHA `<MIGRATION_NUMBER>`; the operator confirms the dev database is already migrated to it, because this workflow runs no migration.
  - Config: `aw-api` must already carry `AW_MODE=production` (see precondition 3).
- **Proposed commands or manual workflow and inputs.**
  1. Operator workstation: confirm digests resolve.
     `gcloud artifacts docker images describe <web_image> --project=<DEV_PROJECT_ID>` and the same for `<api_image>`.
  2. GitHub Actions, workflow **Deploy Dev** (`workflow_dispatch` on `main`, environment `dev` with required reviewers) with inputs `environment=dev`, `sha`, `approval_ref=<THIS_APPROVAL_REF>`, `web_image`, `api_image`.
  3. Download the `deploy-dev-<sha>` artifact as `deploy-summary.json`.
  4. Operator workstation, with two distinct allowlisted users' short-lived IAP ID tokens held in the shell only:
     `export AW_DEV_URL=<AW_WEB_RUN_URL> AW_DEV_OPERATOR_APPROVED_URL=<AW_WEB_RUN_URL> AW_DEV_API_URL=<AW_API_RUN_URL> AW_DEV_DEPLOY_SUMMARY=./deploy-summary.json AW_DEV_EXPECTED_SHA=<APPROVED_40_HEX_SHA> AW_DEV_USER_A_RESOURCE_PATH=/tasks/<USER_A_TASK_ID> AW_DEV_USER_A_PRIVATE_CANARY=<CANARY>` then `pnpm exec playwright test -c e2e/playwright.dev.config.ts`. Tokens come from `<TOKEN_SOURCE_PROCEDURE>`.
  5. `node e2e/dev/scrub-artifacts.mjs e2e/artifacts`, then package as `e2e-dev-artifacts-<sha>`.
- **IAM/OAuth scopes or external writes involved.**
  - GitHub OIDC token exchanged through Workload Identity pool `aw-github`, provider `<DEPLOY_WIF_PROVIDER>`, principalSet restricted to the `dev` environment, impersonating `aw-deployer@<DEV_PROJECT_ID>.iam.gserviceaccount.com`.
  - `aw-deployer` holds `roles/run.developer` on `aw-api` and `aw-web`, Artifact Registry write on `aw-images`, and `roles/iam.serviceAccountUser` on `aw-api` and `aw-web` runtime accounts. No grant is added or changed by this request. The operator confirms `<DEPLOYER_ROLES_CONFIRMED>` matches the Terraform in `infra/terraform/identity/dev` and the `cloud_run_service` module.
  - Writes: two new Cloud Run revisions, one `ask` record per sample and per user in the dev database (synthetic questions), the GitHub artifacts above. No Terraform, IAM, IAP allowlist or secret change.
  - Static keys: none. Repository secrets: none.
- **Expected cost and blast radius.** Two Cloud Run revisions and a few model calls (default 5 samples times the synthetic question) in dev. Blast radius is the dev services and dev database only. `<COST_CEILING>` is the operator's ceiling.
- **Preconditions and local evidence.**
  1. Cloud adoption gate #23 passed, IAP/OAuth security approval `<SECURITY_APPROVAL_REF>`, named owners `<OWNERS>`.
  2. Two distinct real Workspace users `<USER_A>` and `<USER_B>` are in `iap_access`. Until the second exists, the cross-user spec reports BLOCKED.
  3. `AW_MODE=production` is set on `aw-api`. It is not set by `infra/terraform` today, so the operator or the Terraform owner must add it before this request; the workflow refuses to deploy without it. All provider URLs must be real and non-local or `apps/api/src/startup/providers.ts` rejects startup.
  4. Global stop runbook (#102) signed off: `<GLOBAL_STOP_SIGNOFF_REF>`.
  5. Local evidence: `e2e/dev/deploy-workflow.test.ts` and `e2e/playwright.dev.config.test.ts` pass at the recorded SHA; actionlint exit 0 on `deploy-dev.yml`.
- **Stop conditions.** Stop and do not continue if any of these occur.
  - The workflow input validation, digest resolution, `AW_MODE`, or ingress gate refuses.
  - A revision is not ready, or the serving image or traffic split does not match the requested digest.
  - `aw-api` fails startup with `ProductionStartupRejected` (a provider is a fake or missing).
  - The suite reports any cross-user disclosure, any unauthenticated 200 from aw-web or aw-api, or any token present in an unscrubbed artifact.
  - Any step needs an IAM change, IAP allowlist change, `--allow-unauthenticated`, or a static key.
  - Approval expiry passes.
- **Rollback/recovery steps.**
  1. Read `previousImages` in `deploy-summary.json` (the images serving before this deploy).
  2. Run **Deploy Dev** again with `sha=<PREVIOUS_GOOD_SHA>`, `approval_ref=<ROLLBACK_APPROVAL_REF>`, and the previous `aw-api` and `aw-web` digests from `previousImages`.
  3. Confirm both services serve the previous digests with 100% traffic, then rerun the suite or at minimum `sec.direct-run-url-blocked`.
  4. Update the operator `tfvars` `images` map to the serving digests so `terraform plan` shows no image drift.
  5. If the workflow itself is unusable, `gcloud run services update-traffic aw-api|aw-web --to-revisions=<PREVIOUS_REVISION>=100 --project=<DEV_PROJECT_ID> --region=asia-northeast1`.
  6. The workflow runs no migration, so no schema rollback applies. Test records created by the suite are synthetic and left in place unless the operator deletes them.
- **Evidence to capture.**
  - `deploy-dev-<sha>`: `deploy-summary.json` (commit SHA, approvalRef, digests, revisions, previousImages, wall time) and the job summary.
  - `e2e-dev-artifacts-<sha>`, scrubbed: for `skeleton.sign-in-ask-cite-audit` the latency report and trace; `sec.owner-access`; `sec.cross-user-leak` evidence JSON (User A 200 with canary, User B 403/404 without, outsider/forged/random denied); `sec.direct-run-url-blocked` evidence JSON; `deploy-binding.json` in each.
  - The `gcloud run services describe` output for both services after deploy (image and traffic).
  - Measured p95 submit-to-citation (provisional budget 4 s) and CI wall-time metrics.
- **Requested approval scope and expiry.** One run of Deploy Dev for the SHA and digests above, one run of the dev suite, and one rollback run if needed. Expires `<EXPIRY_TIMESTAMP>`.
- **Approver / approval reference / timestamp.** `<APPROVER>` / `<APPROVAL_REF>` / `<TIMESTAMP>`.

Approval is scoped to the listed action and revision. This document is not an approval.
