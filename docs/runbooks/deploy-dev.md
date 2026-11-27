# Dev Cloud Run deployment behind IAP and dev e2e verification

This operator runbook accompanies GitHub issue #24 (`C-06`: deploy to `dev`
behind IAP and run the e2e suite against it). Coding agents may run offline
unit tests, ESLint, Prettier, Knip, and TypeScript checks only. **All Terraform
applies, image pushes, Cloud Run deployments, IAP allowlist changes, and user
token acquisition are human-operator actions.**

## Pilot gate, blocking dependencies, and required follow-ups

1. **Global agent stop sign-off (#102):** Issue #102 supplies the global stop
   runbook ([`docs/runbooks/global-agent-stop.md`](./global-agent-stop.md)) and
   **must be reviewed and signed off before pilot traffic** is admitted.
2. **Cross-user isolation identity gate (`sec.cross-user-leak`):** Cross-user
   tests in [`e2e/dev/cross-user.spec.ts`](../../e2e/dev/cross-user.spec.ts)
   require **two distinct real Workspace test users** in the IAP allowlist
   (`iap_access`). Until a second distinct real test identity is provisioned and
   added to the allowlist, `e2e/dev/cross-user.spec.ts` reports **`BLOCKED`, not
   `PASS`**. The config rejects empty, templated or placeholder tokens and
   refuses to run with `AW_DEV_STACK`, `AW_FAKE_USER` or `AW_FAKE_IAP_URL` set.
3. **Owner-read route for `sec.owner-access` and `sec.cross-user-leak`:**
   `aw-web` serves caller-scoped, read-only `GET /tasks/:id` and
   `GET /artifacts/:id` ([`apps/web/app/tasks/handler.ts`](../../apps/web/app/tasks/handler.ts),
   delivered by TASK-01). Before the run, User A creates a record and the
   operator exports `AW_DEV_USER_A_RESOURCE_PATH` (for example
   `/tasks/<id>`) and `AW_DEV_USER_A_PRIVATE_CANARY` (a string only that record
   contains). The suite reads the exact URL as User A first (`200` plus canary),
   then as User B and as outsiders (`403`/`404`, no canary). Without both
   variables the specs report `BLOCKED`, never `PASS`.
4. **Offline CI vs live cloud evidence:** Offline CI (`.github/workflows/e2e.yml`)
   exercises local fakes and unit/contract suites only. Live deployment metrics
   come from [`.github/workflows/deploy-dev.yml`](../../.github/workflows/deploy-dev.yml)
   (`deploy-dev-<sha>`) and live dev e2e evidence (`e2e-dev-artifacts-<sha>`) is
   collected from an authorized operator workstation run against `AW_DEV_URL`.

## Prerequisites

Complete the steps in
[`docs/runbooks/terraform-bootstrap.md`](./terraform-bootstrap.md) before running
`deploy-dev.yml`:

- `infra/terraform/bootstrap` and `infra/terraform/identity/dev` have been
  planned, reviewed, and applied by the human operator (`aw-deployer`, `aw-web`,
  `aw-api`, and the `aw-github` Workload Identity Pool/Provider exist).
- `infra/terraform/environments/dev` has provisioned the `aw-images` Artifact
  Registry repository in `asia-northeast1`, the `aw-web` (IAP-enabled) and
  `aw-api` (`INGRESS_TRAFFIC_INTERNAL_ONLY`) Cloud Run v2 services, and the
  `iap_access` bindings.
- Secret Manager versions have been populated out-of-band by the operator
  impersonating `aw-tf-dev` (never in Terraform state or GitHub secrets).
- The GitHub repository environment **`dev`** is configured with required
  human reviewers (Yu) and branch deployment restriction to `main`.

## GitHub environment `dev` variables (keyless WIF only)

`aw-deployer` has no `roles/iam.serviceAccountTokenCreator` grant and the pilot
principals are human Google Workspace users, so the GitHub Actions workflow only
deploys Cloud Run revisions via WIF and never mints or handles `AW_DEV_*` user
tokens. Configure the following **GitHub Environment Variables** (`vars.*`) on
the `dev` environment:

| Variable              | Required | Purpose                                                           |
| --------------------- | -------- | ----------------------------------------------------------------- |
| `TF_PROJECT_ID`       | Yes      | Google Cloud dev project ID (e.g. `agent-works-dev`)              |
| `DEPLOY_WIF_PROVIDER` | Yes      | Full Workload Identity Provider resource name from `identity/dev` |
| `DEPLOYER_SA`         | Yes      | `aw-deployer@<TF_PROJECT_ID>.iam.gserviceaccount.com`             |

## aw-api Vertex AI settings (ADR-0008)

[ADR-0008](../adr/0008-vertex-ai-region-and-model.md) sends `aw-api` model
calls to the Vertex AI `global` endpoint with `gemini-4-hydrogen`. It is the
recorded residency exception for model calls only. Cloud Run, Cloud SQL, IAP,
Artifact Registry and the other dev resources stay in `asia-northeast1`.

Set these keys in `service_env.api` of the untracked operator `tfvars`
(commented example in
[`terraform.tfvars.example`](../../infra/terraform/environments/dev/terraform.tfvars.example)),
next to the rest of the `aw-api` env (`DATABASE_URL`, `IAP_*` and so on):

| Key                     | Value               |
| ----------------------- | ------------------- |
| `AW_MODE`               | `production`        |
| `GOOGLE_CLOUD_PROJECT`  | `<TF_PROJECT_ID>`   |
| `GOOGLE_CLOUD_LOCATION` | `global`            |
| `VERTEX_MODEL_ID`       | `gemini-4-hydrogen` |
| `LLM_MODE`              | `vertex`            |

**Deploy Dev** refuses an `aw-api` without `AW_MODE = "production"`.
`LLM_MODE = "stub"` selects the offline model, and no startup check or deploy
guard rejects it, so keep it out of `dev`.

## Building and pushing the images

The root [`Dockerfile`](../../Dockerfile) has one runtime target per service.
Each target is a `linux/amd64`, Node 24 image that holds only the app's
`pnpm deploy --prod` output, runs as `node`, and listens on `$PORT`
(Cloud Run sets it, default `8080`). No credentials are baked in.

Trigger **Build Dev Images**
([`.github/workflows/build-dev-images.yml`](../../.github/workflows/build-dev-images.yml))
manually on `main` with `environment` = `dev` and `sha` = the 40-hex commit on
`origin/main`. The workflow:

1. Checks the `sha` format, that `DEPLOYER_SA` is
   `aw-deployer@<TF_PROJECT_ID>.iam.gserviceaccount.com`, that `sha` is an
   ancestor of `origin/main`, and that it has the root `Dockerfile`, then checks
   out exactly that commit.
2. Authenticates through WIF as `aw-deployer`, which holds
   `roles/artifactregistry.writer` on `aw-images`
   (`module.artifact_registry` in `infra/terraform/environments/dev/main.tf`).
3. Builds `--target api` and `--target web` for `linux/amd64` and pushes them
   as `aw-api:<sha>` and `aw-web:<sha>`. Tags in `aw-images` are immutable, so
   a re-run for the same `sha` reuses the image that is already there.
4. Reads each digest back from Artifact Registry and publishes the
   `api_image` and `web_image` references
   (`asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-{api,web}@sha256:<64-hex>`)
   as job outputs and in the job summary, ready for **Deploy Dev**.

> **Blocked until the WIF mapping allows this workflow.** The `aw-github`
> provider in `infra/terraform/modules/github_wif/main.tf` maps
> `attribute.access` to `dev` only for
> `.github/workflows/deploy-dev.yml@refs/heads/main`. Any other workflow gets
> `denied` and cannot impersonate `aw-deployer`, so **Build Dev Images** fails
> at the WIF step until that mapping also admits
> `.github/workflows/build-dev-images.yml@refs/heads/main` and
> `infra/terraform/identity/dev` is re-applied. That change widens who can act
> as `aw-deployer`, so it needs its own reviewed change.

To build the same images locally (for example on an operator workstation):

```bash
docker build --platform linux/amd64 --target api -t aw-api:local .
docker build --platform linux/amd64 --target web -t aw-web:local .
```

## How to choose and verify image digests

Deployments accept **immutable `@sha256:<64-hex>` digests only** from the
project's regional Artifact Registry repository
`asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images` with the exact
package names `aw-web` and `aw-api`. Mutable tags (`:latest`, `:main`, or
`tag@sha256:...`), swapped service images, and foreign registries are rejected.

1. Verify the target commit `sha` (full 40-char lowercase hex) is merged into
   `origin/main`:
   ```bash
   git fetch origin main
   git rev-parse origin/main
   git merge-base --is-ancestor <40-hex-sha> origin/main
   ```
2. List the verified image digests in Artifact Registry:
   ```bash
   gcloud artifacts docker images list \
     "asia-northeast1-docker.pkg.dev/${TF_PROJECT_ID}/aw-images" \
     --include-tags \
     --format='table(package,version,tags)'
   ```
3. Construct the digest-pinned references:
   - `web_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-web@sha256:<64-hex>`
   - `api_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-api@sha256:<64-hex>`

## Running the manual deployment workflow

Trigger **Deploy Dev** (`.github/workflows/deploy-dev.yml`) manually via the
GitHub Actions UI (`workflow_dispatch` on `main`):

- `environment`: `dev`
- `sha`: `<40-hex commit SHA on origin/main>`
- `approval_ref`: reference to the filled operator approval request
  ([`dep-01/operator-approval.md`](../plans/enterprise-production-v1/dep-01/operator-approval.md))
- `web_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-web@sha256:<64-hex>`
- `api_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-api@sha256:<64-hex>`

What the workflow does:

1. Runs `node e2e/dev/validate-deploy-inputs.mjs` (unit-tested offline) to
   validate `environment == dev`, a real project id and deployer SA, `sha`
   format, a non-placeholder `approval_ref`, `web_image` against
   `^asia-northeast1-docker\.pkg\.dev/${TF_PROJECT_ID}/aw-images/aw-web@sha256:[0-9a-f]{64}$`,
   and `api_image` against the matching `aw-api` pattern, then checks
   `origin/main` ancestry of `sha`.
2. Authenticates via `google-github-actions/auth` using WIF (`DEPLOY_WIF_PROVIDER`)
   as `aw-deployer`.
3. Before any update, proves each digest resolves in Artifact Registry and that
   `aw-api` runs with `AW_MODE=production` and internal-only ingress, and
   records the currently serving images as `previousImages` (the rollback
   targets). It refuses to deploy otherwise. Then updates the two
   Terraform-owned Cloud Run services (`aw-api` and `aw-web`), verifies
   `status.latestReadyRevisionName` matches `status.latestCreatedRevisionName`,
   and verifies each service serves exactly the requested digest with 100% of
   traffic on its latest revision. The workflow never runs Terraform, never
   modifies IAM or IAP settings, and never passes `--allow-unauthenticated` or
   `--no-iap`.
4. Writes the deployed revision names, image digests, `aw-web` url,
   `approvalRef`, `previousImages`, commit SHA, and deploy wall-time to `$GITHUB_STEP_SUMMARY` and `e2e/artifacts/deploy-summary.json`,
   and uploads the sanitized `deploy-dev-<sha>` summary artifact.

> **Terraform drift prevention:** `aw-web` and `aw-api` are Terraform-owned in
> `infra/terraform/environments/dev`. Immediately after a workflow deploy (or
> rollback), update the untracked operator `tfvars` `images` map (`web` and
> `api`) to record the exact same `@sha256:<64-hex>` image references so the
> next `terraform plan` shows zero image drift.

## Operator-workstation dev e2e verification and artifact scrubbing

Because the test principals are real human Google Workspace users behind IAP,
running the dev Playwright suite is an **operator-workstation step**:

1. Obtain short-lived IAP-audience OIDC ID tokens for two distinct allowlisted
   Workspace test users (User A and User B) on your operator workstation without
   writing tokens to disk or shell logs.
2. Export the required `AW_DEV_*` environment variables and run the dev
   Playwright suite:

   ```bash
   # Operator workstation only; never echo or log token values.
   export AW_DEV_URL="https://aw-web-<project-number>.asia-northeast1.run.app"
   export AW_DEV_OPERATOR_APPROVED_URL="${AW_DEV_URL}"
   export AW_DEV_API_URL="https://aw-api-<project-number>.asia-northeast1.run.app"
   export AW_DEV_ID_TOKEN_A="<short-lived-iap-id-token-for-user-a>"
   export AW_DEV_ID_TOKEN_B="<short-lived-iap-id-token-for-user-b>"
   # The approved deployment: the deploy-dev-<sha> artifact and its commit SHA.
   export AW_DEV_DEPLOY_SUMMARY="./deploy-summary.json"
   export AW_DEV_EXPECTED_SHA="<approved-40-hex-sha>"
   # A record User A owns on aw-web and a string only it contains.
   export AW_DEV_USER_A_RESOURCE_PATH="/tasks/<user-a-task-id>"
   export AW_DEV_USER_A_PRIVATE_CANARY="<user-a-only-canary>"

   pnpm exec playwright test -c e2e/playwright.dev.config.ts
   ```

   The config fails closed on an absent or non-https URL, a localhost or IP
   host, absent, placeholder or identical identities, an unset
   `AW_DEV_DEPLOY_SUMMARY`/`AW_DEV_EXPECTED_SHA`, a summary for a different SHA
   or without digest-pinned images, and any fake-stack switch. Each spec attaches
   `deploy-binding.json` so the evidence names the SHA and digests it ran
   against.

3. Scrub all artifacts (including `trace.zip` entries) and verify zero secrets
   or bearer tokens remain using the committed scrubber:
   ```bash
   node e2e/dev/scrub-artifacts.mjs e2e/artifacts
   ```
   `e2e/dev/scrub-artifacts.mjs` uses Node built-ins (`node:zlib`) to redact
   JWT-shaped strings, `Authorization` headers, `x-goog-iap-jwt-assertion`
   headers, and the exact values of `AW_DEV_ID_TOKEN_A` / `AW_DEV_ID_TOKEN_B`
   across all files and inside `.zip` archives (`trace.zip`), and exits non-zero
   if any secret or unredacted token remains.
4. Package the scrubbed `e2e/artifacts` directory as `e2e-dev-artifacts-<sha>`
   and attach it alongside `deploy-dev-<sha>` to issue #24 as operator evidence.

## Rollback procedure (redeploy previous digest)

1. Look up the last known-good `commitSha`, `aw-api` image digest, and `aw-web`
   image digest from the previous successful **Deploy Dev** job summary or
   `deploy-dev-<sha>` (`deploy-summary.json`).
2. Trigger **Deploy Dev** (`workflow_dispatch`) with:
   - `environment`: `dev`
   - `sha`: `<previous known-good 40-hex commit SHA>`
   - `api_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-api@sha256:<previous-api-digest>`
   - `web_image`: `asia-northeast1-docker.pkg.dev/<TF_PROJECT_ID>/aw-images/aw-web@sha256:<previous-web-digest>`
3. Update the untracked operator `tfvars` `images` map (`web` and `api`) to the
   rolled-back digests so the next `terraform plan` shows no image drift, then
   re-run the operator-workstation Playwright verification above.
