# agent-works — Terraform design for Google Cloud dev (DESIGN ONLY)

Status: **design approved 2026-10-15 (all recommended defaults, see §12). Nothing implemented.** Source: fresh clone of `yu-iskw/agent-works` at `a09f0a0`.
Inputs read: `infra/terraform/**`, `.github/workflows/infra.yml`, RFC-001 §5, §14, ADR `docs/adr/0003-pilot-decisions.md`,
`docs/runbooks/cloud-workflows-dev.md`, `docs/plans/phase3-readiness-matrix.md`, `apps/api/src/config.ts` and the env reads in `apps/**`,
`docs/governance/encryption-and-redaction.md`, `docs/analytics/integration.md`, `docs/scheduling/README.md`, `/workspace/agent-works-operator-checklist.md`.

Yu's hard rules (binding):

1. **Modules never create service accounts.** They take SA emails as inputs.
2. **One SA per responsibility**, least privilege, roles granted at the narrowest resource.
3. **Impersonation everywhere.** Terraform impersonates a terraform SA, there are no SA keys, CI uses WIF to impersonate the deployer, and humans get `roles/iam.serviceAccountTokenCreator` only on specific SAs.

---

## 1. What exists today, and what conflicts with the rules

| Fact (repo)                                                                                                                                                                                                  | Path                                                                                                        | Consequence                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/environment` creates the **project**, 5 control-plane APIs, audit config, org-policy guards, default-SA deprivilege, budget **and the 5 SAs** (`google_service_account.this`)                       | `infra/terraform/modules/environment/{main,identities,guard,budget,catalogue}.tf`                           | **Violates rule 1.** Split: project and SAs move to the root modules (§2). Guards, audit and budget stay as modules.                                 |
| `modules/workflows` creates its own SA `pilot-workflow`                                                                                                                                                      | `infra/terraform/modules/workflows/main.tf` (`google_service_account.workflow`)                             | **Violates rule 1.** Change it to take `workflow_service_account_email`. Bootstrap owns its custom adapter role; keep distinct-identity validations. |
| Dev root calls `modules/environment` with slots bff, task_service, tool_broker, scheduled_execution and deployer                                                                                             | `infra/terraform/environments/dev/main.tf`                                                                  | SA names are reused in §4 so the existing plan tests can still be read the same way.                                                                 |
| Provider is region-only, with no `impersonate_service_account` and no backend                                                                                                                                | `environments/dev/providers.tf`, `versions.tf`                                                              | Add the backend and impersonation (§5, §6).                                                                                                          |
| Pins: Terraform `>=1.16.5,<1.17.0`, google `8.5.0`                                                                                                                                                           | `versions.tf` (all)                                                                                         | Keep. Pin `google-beta 8.5.0` too, only if IAP brand or client resources are used (§9).                                                              |
| CI runs only offline checks (`init -backend=false`, validate, tflint)                                                                                                                                        | `.github/workflows/infra.yml`                                                                               | Unchanged. Add a separate manual plan job later (§6).                                                                                                |
| Gaps: no backend, Cloud Run, IAP, OAuth, Secret Manager, Artifact Registry or WIF, and no runtime APIs                                                                                                       | checklist "Gaps" 1–4                                                                                        | Covered by the new modules below.                                                                                                                    |
| Runtime config the API reads: `DATABASE_URL`, `IAP_AUDIENCE/ISSUER/JWKS_URL`, `DRIVE_WORKER_TOKEN`, `OAUTH_URL`, `OAUTH_PUBLIC_URL`, `LLM_URL`, `DIRECTORY_URL`, `ADMIN_TRUSTED_ORIGINS`, `PORT`, `NODE_ENV` | `apps/api/src/config.ts`, `rg process.env apps`                                                             | Drives the secrets list (§8) and the Cloud Run env (module `cloud_run_service`).                                                                     |
| Cloud KMS, BigQuery, Cloud Scheduler, Pub/Sub and Eventarc are only **feature-gated stubs**                                                                                                                  | `docs/governance/encryption-and-redaction.md`, `docs/analytics/integration.md`, `docs/scheduling/README.md` | Modules for them are designed but **off by default** (`enable_* = false`).                                                                           |
| Postgres / Cloud SQL target **not documented**                                                                                                                                                               | checklist A6                                                                                                | Resolved D1: off-cloud. The `cloud_sql` module is designed but off.                                                                                  |

## 2. Directory layout

```text
infra/terraform/
  bootstrap/                  # root 0, applied ONCE by Yu with his own ADC (no SA yet). Local state, then migrated to GCS.
    main.tf                   #   project (moved from modules/environment), state bucket, tf-applier SAs, Yu's tokenCreator grants
  identity/dev/               # root 1, runs as sa-tf-identity. Creates ALL runtime/CI SAs + WIF pool/provider
    service_accounts.tf       #   google_service_account resources (the ONLY place besides bootstrap that creates SAs)
    impersonation.tf          #   tokenCreator / serviceAccountUser / workloadIdentityUser bindings on individual SAs
    wif.tf                    #   uses modules/github_wif
    outputs.tf                #   map of SA emails -> consumed by envs/dev via terraform_remote_state
  environments/dev/           # root 2 (existing path kept), runs as sa-tf-dev. Every resource lives in a module; SA emails come in as inputs
    backend.tf providers.tf versions.tf variables.tf main.tf tenant.tf (kept) workflows.tf (kept, rewired)
  modules/
    project_baseline/         # was modules/environment minus project and SAs: APIs, audit config, org-policy guard, deprivilege
    budget/                   # split out of environment/budget.tf (unchanged behaviour: alerts only, ADR 0003)
    project_iam/              # project-level role grants for given SA emails (bootstrap custom provisioning grants are colocated with their roles)
    artifact_registry/
    secrets/
    cloud_run_service/        # one service + its invoker IAM + optional direct IAP
    iap_access/               # IAP accessor grants for test users/groups
    workflows/                # existing, refactored to take the workflow SA email
    scheduler_job/            # off by default
    kms/                      # off by default
    cloud_sql/                # off (D1)
    network/                  # VPC + Direct VPC egress, off (D10)
    bigquery_analytics/       # off by default (analytics BigQuery switched off)
    github_wif/               # pool + provider (used by identity root)
```

Why three roots: the identity root holds IAM power (it creates SAs and the WIF provider). Keeping it apart from the workload root means `sa-tf-dev` never needs `iam.serviceAccountAdmin`. This is RFC §14.1: "Avoid granting a single deployment identity Owner".

## 3. Modules: purpose, inputs and outputs, resources

No module declares `google_service_account` or `google_service_account_key`. CI enforces this with a static check (`rg 'resource "google_service_account"( |_key)' infra/terraform/modules` must return nothing). That's a design note only; it gets added as a tflint/custom check when implemented.

| Module               | Purpose                                                                               | Key inputs                                                                                                                                                                            | Outputs                                           | Resources                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `project_baseline`   | Hardening of an **existing** project                                                  | `project_id`, `apis` (set), `guard_constraints`                                                                                                                                       | `enabled_apis`, `org_policies`, `audit_log`       | `google_project_service`, `google_project_iam_audit_config`, `google_org_policy_policy`, `google_project_default_service_accounts` (DEPRIVILEGE) |
| `budget`             | Alerts-only budget (ADR 0003: no cap, no automation channel)                          | `billing_account_id`, `project_number`, `currency_code`, `reference_amount`, `alert_at`                                                                                               | `thresholds`                                      | `google_billing_budget`                                                                                                                          |
| `project_iam`        | Project-scoped roles for given members, as an additive per-member grant list          | `project_id`, `grants = map(object({member, roles}))`                                                                                                                                 | `iam_bindings`                                    | `google_project_iam_member`                                                                                                                      |
| `artifact_registry`  | Docker repo in `asia-northeast1` with immutable tags                                  | `project_id`, `repository_id`, `writer_emails`, `reader_emails`                                                                                                                       | `repository_url`                                  | `google_artifact_registry_repository`, `..._repository_iam_member`                                                                               |
| `secrets`            | Secret **containers** and per-secret accessor IAM. **No secret values in Terraform.** | `project_id`, `secrets = map(object({accessor_emails, version_adder_emails}))`                                                                                                        | `secret_ids`                                      | `google_secret_manager_secret` (user-managed replication `asia-northeast1`), `..._secret_iam_member`                                             |
| `cloud_run_service`  | One Cloud Run v2 service, pinned by **image digest**                                  | `project_id`, `name`, `image` (must contain `@sha256:`), `service_account_email`, `env`, `secret_env = map(secret_id)`, `ingress`, `invoker_members`, `iap_enabled`, `deployer_email` | `uri`, `name`                                     | `google_cloud_run_v2_service`, `..._service_iam_member` (invoker)                                                                                |
| `iap_access`         | Who may pass IAP. Test users and groups only, and the outsider gets nothing (#21).    | `project_id`, `region`, `service_name`, `members`                                                                                                                                     | `members`                                         | `google_iap_web_cloud_run_service_iam_member` (direct IAP, D3)                                                                                   |
| `workflows`          | Existing. Takes `workflow_service_account_email` instead of creating one              | existing inputs + `workflow_service_account_email`                                                                                                                                    | existing `adapter`, `permissions`, `iam_bindings` | minus `google_service_account.workflow`                                                                                                          |
| `scheduler_job`      | Cloud Scheduler job invoking Workflows or Run with OIDC                               | `project_id`, `name`, `schedule`, `target`, `invoker_service_account_email`                                                                                                           | `job_id`                                          | `google_cloud_scheduler_job`                                                                                                                     |
| `kms`                | Keyring and key for governance envelope encryption (replaces `createCloudKmsStub`)    | `project_id`, `keyring`, `key`, `encrypter_decrypter_emails`                                                                                                                          | `key_id`                                          | `google_kms_key_ring`, `google_kms_crypto_key`, `..._crypto_key_iam_member`                                                                      |
| `cloud_sql`          | Private-IP Postgres, IAM DB auth, no authorized networks (RFC §14.2)                  | `project_id`, `network`, `client_emails`, `tier`                                                                                                                                      | `connection_name`                                 | `google_sql_database_instance`, `google_sql_user` (CLOUD_IAM_SERVICE_ACCOUNT)                                                                    |
| `bigquery_analytics` | Approved datasets, read-only for the analytics identity                               | `project_id`, `datasets`, `reader_emails`, `job_user_emails`                                                                                                                          | `dataset_ids`                                     | `google_bigquery_dataset`, `..._dataset_iam_member`                                                                                              |
| `github_wif`         | GitHub OIDC pool and provider, restricted to repo, ref and environment                | `project_id`, `pool_id`, `repository` (`yu-iskw/agent-works`), `attribute_condition`                                                                                                  | `provider_name`, `pool_name`                      | `google_iam_workload_identity_pool(_provider)`                                                                                                   |

Illustrative interfaces only:

```hcl
# modules/cloud_run_service/variables.tf (interface sketch)
variable "service_account_email" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+@[a-z][a-z0-9-]+\\.iam\\.gserviceaccount\\.com$", var.service_account_email))
    error_message = "Pass an existing SA email; this module creates no identities."
  }
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Pin by digest (RFC §14.3)."
  }
}
variable "secret_env" { type = map(string) } # ENV_NAME => secret_id; values never pass through Terraform
variable "ingress"     { type = string, default = "INGRESS_TRAFFIC_ALL" } # direct IAP guards the run.app URL (D3)
variable "iap_enabled" { type = bool,   default = true }
```

```hcl
# modules/secrets/variables.tf (interface sketch)
variable "secrets" {
  type = map(object({
    accessor_emails      = set(string) # runtime SAs only
    version_adder_emails = set(string) # empty by default: Yu adds versions by hand via impersonation
  }))
}
```

```hcl
# environments/dev/main.tf (wiring sketch)
data "terraform_remote_state" "identity" {
  backend = "gcs"
  config  = { bucket = var.state_bucket, prefix = "identity/dev" }
}
locals { sa = data.terraform_remote_state.identity.outputs.service_account_emails }

module "api" {
  source                = "../../modules/cloud_run_service"
  name                  = "aw-api"
  service_account_email = local.sa.api
  invoker_members       = ["serviceAccount:${local.sa.web}", "serviceAccount:${local.sa.scheduler}"]
  # ...
}
```

## 4. Service accounts (all created in `bootstrap/` or `identity/dev/`)

Prefix `aw-` (≤30 chars). They replace `pilot-*` in `environments/dev/main.tf` (D2). Roles are granted at **resource** scope wherever GCP supports it. "Imp." means who may impersonate the SA (tokenCreator), who may attach it (serviceAccountUser) or who may federate into it (workloadIdentityUser).

| SA                                                     | Created in | Responsibility                                                                       | Roles (scope)                                                                                                                                                                                                                                                                                                                                                                                                                                            | Imp. / attach                                                                                          |
| ------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `aw-tf-identity`                                       | bootstrap  | Applies `identity/dev`                                                               | `iam.serviceAccountAdmin`, `iam.workloadIdentityPoolAdmin` (project); write on the state bucket prefix `identity/`                                                                                                                                                                                                                                                                                                                                       | tokenCreator: **Yu only**                                                                              |
| `aw-tf-dev`                                            | bootstrap  | Applies `environments/dev`                                                           | `serviceusage.serviceUsageAdmin`, `run.admin`, `artifactregistry.admin`, `secretmanager.admin`, `iap.admin`, `workflows.admin`, `cloudscheduler.admin`, `logging.configWriter`, `resourcemanager.projectIamAdmin` constrained by an IAM **condition** that limits grantable roles to the list in §4.1, `billing.costsManager` on the billing account (budget only). serviceAccountUser on each runtime SA (to attach them). Write on state prefix `dev/` | tokenCreator: **Yu only**                                                                              |
| `aw-tf-plan`                                           | bootstrap  | Read-only `plan` (optional CI plan job)                                              | `viewer`, `iam.securityReviewer`, `secretmanager.viewer` (metadata only, no access), read on the state bucket                                                                                                                                                                                                                                                                                                                                            | workloadIdentityUser: GitHub `pull_request` on this repo; tokenCreator: Yu                             |
| `aw-deployer` (= `pilot-deployer`)                     | identity   | CI pushes images and rolls out a new revision                                        | `artifactregistry.writer` (**repo** scope), `run.developer` (**per service**), serviceAccountUser on `aw-web` and `aw-api` only                                                                                                                                                                                                                                                                                                                          | workloadIdentityUser: GitHub OIDC with `repository == yu-iskw/agent-works && environment == dev` (#24) |
| `aw-web` (= `pilot-bff`)                               | identity   | Runtime of `apps/web` (IAP front door / BFF)                                         | `logging.logWriter`, `monitoring.metricWriter`, `cloudtrace.agent` (project); `run.invoker` on `aw-api` only                                                                                                                                                                                                                                                                                                                                             | attach: aw-deployer, aw-tf-dev. No human tokenCreator                                                  |
| `aw-api` (= `pilot-task-service`)                      | identity   | Runtime of `apps/api`: tasks, ledger, approvals, governance and memory               | observability trio; `secretmanager.secretAccessor` on **its** secrets only; `cloudsql.client` + `cloudsql.instanceUser` (only if Cloud SQL is ever enabled; off per D1); `cloudkms.cryptoKeyEncrypterDecrypter` on the governance key (if enabled); `aiplatform.user` (#108, D-09); the existing custom Workflows adapter role (owned by bootstrap)                                                                                                      | attach: aw-deployer, aw-tf-dev                                                                         |
| `aw-tool-broker` (= `pilot-tool-broker`)               | identity   | Brokered egress, connectors (Drive/Docs/Gmail/Calendar via per-user OAuth, RFC §5.3) | observability trio; secretAccessor on the OAuth client secret and `DRIVE_WORKER_TOKEN` only                                                                                                                                                                                                                                                                                                                                                              | attach: aw-deployer, aw-tf-dev                                                                         |
| `aw-workflow` (was created inside `modules/workflows`) | identity   | Cloud Workflows execution identity                                                   | `run.invoker` on the **broker** service only (as today); `logging.logWriter`                                                                                                                                                                                                                                                                                                                                                                             | attach: aw-tf-dev (serviceAccountUser, replaces the module's deployer grant)                           |
| `aw-scheduler` (= `pilot-scheduled-exec`)              | identity   | Cloud Scheduler OIDC invoker for user-created schedules (D-11)                       | `run.invoker` on `aw-api` only, or `workflows.invoker` on the single workflow                                                                                                                                                                                                                                                                                                                                                                            | attach: aw-tf-dev                                                                                      |
| `aw-analytics` (only if BigQuery is enabled)           | identity   | Read-only analytics queries (#147)                                                   | `bigquery.dataViewer` on approved **datasets**, `bigquery.jobUser` (project)                                                                                                                                                                                                                                                                                                                                                                             | attach: aw-tf-dev                                                                                      |
| `aw-agent` (only if #105/#112 pass)                    | identity   | Agent Runtime principal, separate from the API                                       | per #112 outcome; no data roles by default                                                                                                                                                                                                                                                                                                                                                                                                               | attach: aw-tf-dev                                                                                      |

### 4.1 `aw-tf-dev` IAM-grant guardrail

`resourcemanager.projectIamAdmin` comes with the condition `api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly([...])`. The list holds the roles in the table above. This stops the dev applier from granting itself or anyone `owner` or `editor`. That needs verification on google `8.5.0` and in the console (decided: D6).

### 4.2 Humans

- Yu gets `roles/iam.serviceAccountTokenCreator` **on `aw-tf-identity`, `aw-tf-dev` and `aw-tf-plan` only**, granted per SA (`google_service_account_iam_member`), never at project level.
- Yu drops project `owner` after bootstrap (D4). Break-glass is a Google group with no standing roles (§12).
- Test users (Alice, Bob, reviewers) get IAP access only. The outsider gets nothing (#21).
- Org policies `iam.disableServiceAccountKeyCreation` and `iam.disableServiceAccountKeyUpload` stay enforced (`modules/environment/guard.tf`). That makes "no keys" technical, not just a convention.

### 4.2 Bootstrap-owned optional provisioning

Bootstrap owns the conditioned `aw-tf-dev` project IAM grant and the fixed
`pilot_durable_tasks_adapter` role (created only with `enable_workflows`). The
Workflows module only assigns that role; neither applier receives custom-role
management permissions. Identity/dev retains only SA and WIF administration.

Bootstrap feature flags must match the dev flags before optional modules are
provisioned. `enable_network`, `enable_nat` (also requires networking),
`enable_cloud_sql`, `enable_kms` and `enable_bigquery_analytics` gate project-scoped
custom provisioning roles granted only to `aw-tf-dev`. Exact permissions live in
`bootstrap/provisioning.tf` and literal mock-plan test snapshots: network/subnet
lifecycle and operation polling; separate router/NAT lifecycle; private SQL
instance/user lifecycle, peering and reserved address management; KMS keyring/key
metadata and key IAM; BigQuery dataset lifecycle and dataset IAM. These roles omit
SQL data access, KMS encrypt/decrypt, BigQuery table data/query jobs, SA/key creation
and custom-role administration. They are project-scoped because creation precedes
resource existence; runtime access stays resource-scoped.

## 5. Impersonation flows

```mermaid
flowchart LR
  Yu[Yu<br/>gcloud ADC] -- tokenCreator --> TFI[aw-tf-identity]
  Yu -- tokenCreator --> TFD[aw-tf-dev]
  Yu -- tokenCreator --> TFP[aw-tf-plan]
  TFI -->|apply identity/dev| SAs[(runtime + CI SAs<br/>WIF pool)]
  TFD -->|apply environments/dev| RES[(Run, AR, Secrets, IAP,<br/>Workflows, Scheduler)]
  TFD -. serviceAccountUser .-> RT[aw-web / aw-api / aw-tool-broker /<br/>aw-workflow / aw-scheduler]
  GH[GitHub Actions<br/>env=dev, OIDC] -- WIF workloadIdentityUser --> DEP[aw-deployer]
  DEP -->|push image| AR[(Artifact Registry)]
  DEP -->|new revision| RUN[(Cloud Run aw-web, aw-api)]
  DEP -. serviceAccountUser .-> RT
```

```mermaid
sequenceDiagram
  participant Y as Yu (ADC, no keys)
  participant TF as terraform
  participant IAM as IAM Credentials API
  participant GCP as Google APIs
  Y->>TF: terraform plan/apply (environments/dev)
  TF->>IAM: generateAccessToken(aw-tf-dev) using Yu's ADC
  IAM-->>TF: short-lived token (1h)
  TF->>GCP: all calls + GCS state as aw-tf-dev
```

Provider and backend both impersonate:

```hcl
provider "google" {
  region                      = "asia-northeast1"
  impersonate_service_account = var.terraform_service_account   # aw-tf-dev@...
}
terraform {
  backend "gcs" {
    bucket                      = "<project>-tfstate"            # supplied via -backend-config, untracked
    prefix                      = "dev"
    impersonate_service_account = "aw-tf-dev@<project>.iam.gserviceaccount.com"
  }
}
```

The CI deploy (#24, `deploy-dev.yml`, not written yet) uses `google-github-actions/auth` with `workload_identity_provider` and `service_account = aw-deployer`. Both values are GitHub **environment variables**, not secrets. The job is gated on environment `dev` with Yu as required reviewer.

## 6. State backend and bootstrap order

- **Bucket:** `<project_id>-tfstate` in `asia-northeast1`, created by `bootstrap/`. Uniform bucket-level access, public-access prevention, versioning on with lifecycle that keeps 30 noncurrent versions, and Google-managed encryption (D7). GCS has native state locking, so no extra lock table is needed.
- **Prefixes:** `bootstrap/`, `identity/dev/`, `dev/`. Per-prefix object read/write via IAM conditions on `resource.name.startsWith(...)`. Both appliers additionally receive a bucket-scoped custom role containing only `storage.objects.list` for GCS backend workspace discovery; listing exposes object names but grants no object reads/writes. `aw-tf-plan` gets read only.
- **Single project:** the state lives in the dev project itself. That's acceptable for the pilot. RFC §14.1 suggests a separate admin or security project later (D8).

Order (all manual, run by Yu):

1. **bootstrap** (Yu's own ADC, local state): project (moved from `modules/environment/main.tf`; use `terraform state mv` or import if it already exists), APIs needed for bootstrap (`iam`, `iamcredentials`, `storage`, `serviceusage`, `cloudresourcemanager`), the state bucket, `aw-tf-identity`, `aw-tf-dev`, `aw-tf-plan`, and Yu's tokenCreator on each. Then `terraform init -migrate-state` into `gs://…/bootstrap`.
2. **identity/dev** as `aw-tf-identity`: all runtime and CI SAs, the WIF pool and provider, and the attach/federate bindings. Output: the email map.
3. **environments/dev** as `aw-tf-dev`, in two passes:
   1. `project_baseline` (APIs, guards, audit), `budget`, `project_iam`, `artifact_registry`, `secrets` (containers only).
   2. Yu adds the secret versions by hand (§8). CI builds and pushes the first image. Then `cloud_run_service`, `iap_access`, and the optional modules.
4. Optional later: `enable_workflows = true` per `docs/runbooks/cloud-workflows-dev.md`.

All applies follow the existing runbook pattern: `plan -out`, review, then apply the saved plan.

## 7. API enablement (`project_baseline.apis`)

| Group                         | APIs                                                                                                                                          | Why                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Existing control plane (keep) | `billingbudgets`, `cloudresourcemanager`, `iam`, `orgpolicy`, `serviceusage`                                                                  | `modules/environment/catalogue.tf` |
| Impersonation and state       | `iamcredentials`, `sts`, `storage`                                                                                                            | Token minting, WIF, GCS backend    |
| Runtime                       | `run`, `artifactregistry`, `secretmanager`, `iap`, `logging`, `monitoring`, `cloudtrace`                                                      | Checklist gap 4, RFC §14.2         |
| Model                         | `aiplatform`                                                                                                                                  | #108, D-09                         |
| Connectors (per-user OAuth)   | `drive`, `docs`, `gmail`, `calendar-json`                                                                                                     | #146 / #110, D-03, D-07            |
| Opt-in, behind flags          | `workflows`, `workflowexecutions` (already in `modules/workflows`), `cloudscheduler`, `cloudkms`, `sqladmin`, `bigquery`, `servicenetworking` | Stubs today                        |

All use `disable_on_destroy = false`, as the code already does.

## 8. Secrets handling

- Terraform creates **secret containers and IAM only**. Values never enter tfvars, state, plans or logs. That follows the repo rule "no tokens in repo/tfvars/logs" (checklist header).
- Yu adds versions himself: `gcloud secrets versions add … --impersonate-service-account=aw-tf-dev`. (D9: no separate writer SA.)
- Initial secrets, derived from code:

| Secret                                                      | Read by          | Source                                     |
| ----------------------------------------------------------- | ---------------- | ------------------------------------------ |
| `oauth-client-secret`                                       | `aw-tool-broker` | per-user OAuth client (checklist A5, D-07) |
| `drive-worker-token`                                        | `aw-tool-broker` | `DRIVE_WORKER_TOKEN` (`apps/**`)           |
| `database-url` (only if Cloud SQL is used without IAM auth) | `aw-api`         | `DATABASE_URL` (`apps/api/src/config.ts`)  |

- Non-secret config (`IAP_AUDIENCE`, `IAP_ISSUER`, `IAP_JWKS_URL`, `OAUTH_URL`, `OAUTH_PUBLIC_URL`, `ADMIN_TRUSTED_ORIGINS`, `LLM_URL`, `DIRECTORY_URL`) goes in as plain `env` on `cloud_run_service`.
- Cloud Run mounts secrets as `secret_env` pinned to a **version number**, not `latest`, so a rotation shows up as a reviewed plan.

## 9. What stays manual (console, by Yu)

- **OAuth consent screen and brand (Internal):** the `google_iap_brand`/`google_iap_client` resources are deprecated by Google. The brand is also one-per-project and can't be deleted.
- **The per-user OAuth client** for Workspace connectors, and its secret value.
- **Workspace admin scope approval** (D-07).
- **Test tenant users and groups:** Alice, Bob, the outsider and the reviewers group. `tenant.tf` stays data-only (ADR 0003).
- **Drive test corpus** for #110.
- **Secret versions** (§8), **GitHub environment `dev`** with Yu as required reviewer, and the WIF provider and SA as environment variables.
- **Every `apply`** (bootstrap, identity and dev), plus picking the image digest for deploys.

## 10. Mapping to the checklist and issues

| Checklist step         | Issues                                              | Covered by                                                                                                                                                 |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 prereqs and backend | all                                                 | `bootstrap/` (project, state bucket, terraform SAs)                                                                                                        |
| A2 Terraform dev env   | #19 output                                          | `identity/dev` + `environments/dev` (refactored `modules/environment`)                                                                                     |
| A3 runtime APIs        | #105 #108 #24 #110 #25                              | `project_baseline.apis` (§7)                                                                                                                               |
| A4 tenant and users    | #21 #109 #110 #22                                   | manual (§9). `iap_access` grants them access afterwards                                                                                                    |
| A5 IAP + OAuth         | #21 #24 #110                                        | `cloud_run_service.iap_enabled` + `iap_access` + `secrets`; brand and client manual                                                                        |
| A6 build and deploy    | #24                                                 | `artifact_registry`, `github_wif`, `aw-deployer`, `cloud_run_service`; `deploy-dev.yml` written later by SWE                                               |
| A7 probes              | #105 #106 #107 #108 #111 #112                       | `aw-api` gets `aiplatform.user` (#108). `aw-agent` is created only after #112 says GO. #106 needs egress design; `modules/network` exists but is off (D10) |
| A7 #109 managed search | #109                                                | not provisioned (defer unless a Gemini Enterprise trial exists, ADR 0003)                                                                                  |
| A8 Workflows           | #25                                                 | refactored `modules/workflows` + `aw-workflow` SA from identity root                                                                                       |
| Decisions              | D-01 region, D-07 OAuth, D-09 model, D-11 schedules | region locked by validation to `asia-northeast1` (as in `modules/workflows/variables.tf`); D-07/D-09/D-11 reflected in SA roles                            |

## 11. Risks

- **Refactor and state migration:** the project and the 5 SAs move out of `modules/environment`. Without `moved {}` blocks or `terraform state mv`, a plan would **destroy and recreate** them. The project has `deletion_policy = "PREVENT"`. Nothing has been applied yet (checklist A2 open), so if Yu hasn't applied, this is free.
- **`aw-tf-dev` stays powerful** (projectIamAdmin). The condition in §4.1 mitigates it but needs testing, and some resources (`google_project_iam_audit_config`, org policy) need broad roles.
- **Bootstrap chicken-and-egg:** step 1 runs with Yu's own credentials. This is the one non-impersonated apply.
- **Direct Cloud Run IAP:** verified as supported in google `8.5.0` (§12.1). The remaining risk is a live one: #21 must prove that an outsider gets 403 on the `run.app` URL.
- **Plan tests:** `infra.yml` runs plan-level tests (e.g. `budget-alerts-only`). These must be ported to the new module boundaries.

## 12. Decisions (Yu, 2026-10-15: all recommended defaults)

The numbers follow this doc's original Q1–Q11. The parent's relay numbered them in a different order, but the content is the same.

| #         | Decision                                                                   | Design effect                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 (Q1)   | **Database stays off-cloud** for the pilot                                 | `cloud_sql` module exists with `enable_cloud_sql = false`. No `sqladmin` or `servicenetworking` API by default. `database-url` secret not created.                                                                                                                                                                                                                                       |
| D2 (Q2)   | **Rename `pilot-*` to `aw-*`**                                             | The identity root creates `aw-*`. Nothing has been applied (checklist A2 open), so no `moved` blocks are needed for SAs. Existing plan tests are updated to the new names.                                                                                                                                                                                                               |
| D3 (Q3)   | **IAP directly on Cloud Run** (no load balancer)                           | `cloud_run_service` sets `iap_enabled = true` and `ingress = INGRESS_TRAFFIC_ALL`. `iap_access` uses `google_iap_web_cloud_run_service_iam_member`. The IAP service agent `service-<number>@gcp-sa-iap.iam.gserviceaccount.com` gets `run.invoker` on the service. Provider support is verified in §12.1.                                                                                |
| D4 (Q4)   | **Drop Owner after bootstrap**; impersonation plus a **break-glass group** | Bootstrap's last step removes Yu's `owner`. A group `aw-breakglass@<domain>` (members managed by hand) gets tokenCreator on `aw-tf-identity` only, with no standing project roles. Use is logged by the existing `allServices` audit config.                                                                                                                                             |
| D5 (Q5)   | **Org policies applied in bootstrap**                                      | The guard constraints move from `modules/environment/guard.tf` into a `project_baseline` call made **only by bootstrap**. `aw-tf-dev` does not get `orgpolicy.policyAdmin`.                                                                                                                                                                                                              |
| D6 (Q6)   | **Allowlist IAM condition on `aw-tf-dev`**                                 | `projectIamAdmin` with the `modifiedGrantsByRole hasOnly([...])` condition. The allowlist and conditioned grant live in bootstrap; the identity applier never writes project IAM. Owner, editor and any `iam.*Admin` role are never in it.                                                                                                                                               |
| D7 (Q7)   | **Google-managed encryption** for state                                    | No KMS for the bucket. The `kms` module stays only for the governance key, off by default.                                                                                                                                                                                                                                                                                               |
| D8 (Q8)   | **State in the dev project**                                               | `<project_id>-tfstate` in `asia-northeast1`, with prefixes `bootstrap/`, `identity/dev/` and `dev/`.                                                                                                                                                                                                                                                                                     |
| D9 (Q9)   | **Yu writes secret values while impersonating `aw-tf-dev`**                | `aw-tf-dev` keeps `secretmanager.admin`. There is no `aw-secret-writer` SA. Versions are added with `gcloud secrets versions add --impersonate-service-account=aw-tf-dev@…`, never through Terraform.                                                                                                                                                                                    |
| D10 (Q10) | **Network/egress module included, off by default**                         | New `modules/network`: VPC, subnet, Direct VPC egress for Cloud Run, and an optional Cloud NAT. `enable_network = false` by default. Web/API images require `enable_network = true`: Direct VPC `ALL_TRAFFIC` and subnet Private Google Access route calls to internal API ingress. NAT remains optional for external internet destinations; foundations-only plans keep networking off. |
| D11 (Q11) | **Read-only plan CI job via `aw-tf-plan` + WIF**                           | New workflow job, manual and on PRs: WIF → `aw-tf-plan` → `terraform plan -lock=false` on `environments/dev`. It can't apply: `aw-tf-plan` has viewer roles and read-only state access. The WIF provider condition limits it to the repo. It's written in the bundle but stays **inert until Yu sets the environment variables** after bootstrap.                                        |

### 12.1 D3 provider verification (done offline, 2026-10-15)

- **Repo pin:** `hashicorp/google` `8.5.0` exactly, with Terraform `>=1.16.5,<1.17.0` (`infra/terraform/*/versions.tf`).
- **`iap_enabled` in the GA provider:** at tag `v8.5.0`, `google/services/cloudrunv2/resource_cloud_run_v2_service.go` defines the `iap_enabled` field (line ~1218) and expands it into the API request (line ~1798). The docs page `website/docs/r/cloud_run_v2_service.html.markdown` lists `iap_enabled` as Optional and has the example "Cloudrunv2 Service Iap", which uses the **GA** provider (no `provider = google-beta`; the beta-marked examples in that page are other features). → **Supported in the GA `google` 8.5.0. No `google-beta` needed.**
- **IAP access grants:** `google_iap_web_cloud_run_service_iam_member` is documented at the same tag (`website/docs/r/iap_web_cloud_run_service_iam.html.markdown`).
- **Caveats:** the 8.5.0 changelog at that tag is still headed "Unreleased", so the release is checked at `terraform init` in CI. The IAP OAuth brand stays manual (§9). The live behaviour (an outsider gets 403 on `run.app`) is proved by #21, not by Terraform.

### 12.2 Remaining open items (not blocking the bundle)

- The break-glass group address and its members (Yu).
- The final image digest and the first deploy belong to #24.
