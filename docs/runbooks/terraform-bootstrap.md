# Keyless Terraform bootstrap and dev rollout

This is a human operator runbook, implementing the approved
[Terraform design](../../infra/terraform/DESIGN.md). Agents may only run offline
formatting, `init -backend=false`, validation and mock plan tests. All cloud
operations, backend migration and applies below are operator-only. Never place
credentials, secret values or actual ids in tracked tfvars or logs.

## Prepare and review

Use Terraform 1.16.5 and Google 8.5.0. Replace the placeholders in each root's
`terraform.tfvars.example` in protected untracked operator files. Supply the project,
folder, billing account, Yu's user principal and the manually maintained break-glass
group. Region is fixed to asia-northeast1. Keep Owner only for initial bootstrap.
Review a saved plan and approve that exact plan before every operator apply.

For a previously applied tree, back up state before refactoring. The project
formerly at `module.dev.google_project.this` belongs at `google_project.dev` in
bootstrap. Move/import it across roots using operator-reviewed state operations;
never permit its destruction/recreation. Guard policies and default-SA deprivilege
also move into bootstrap's baseline. Audit/APIs, budget and IAM change addresses
when modules split: review imports/state moves before planning against existing
state. D2 renames pilot-* accounts to aw-*; the approved design assumes the old
accounts have never been applied. If that assumption is false, stop and review a
migration; do not use an unattended replacement plan.

## Bootstrap: local state first

The human operator uses their own keyless ADC for this root only. It creates the
project with deletion prevented, bootstrap APIs, enforced key creation/upload and
default-SA automatic-grant guards, deprivileges default accounts, and enables
allServices audit reads/writes. It creates aw-tf-identity, aw-tf-dev and aw-tf-plan.
Yu receives tokenCreator on those three accounts individually, never project-wide.
The break-glass group receives tokenCreator only on aw-tf-identity, with no project
roles and no automatic group membership management.

The state bucket lives in the dev project, has uniform access, public-access
prevention, versioning retaining thirty noncurrent versions, and Google-managed
encryption (D7). aw-tf-identity may write only identity/ objects, aw-tf-dev only dev/
objects and may read identity/ to consume the map. aw-tf-plan may read objects only.
No state key material or CMEK is provisioned.

After reviewing/bootstrap applying locally, the operator migrates bootstrap state
to prefix bootstrap/. Add a protected bootstrap backend configuration whose GCS
block includes bucket, prefix and `impersonate_service_account`; backend blocks
cannot reference input variables. Grant the selected bootstrap maintenance SA
only the needed bootstrap/ object permissions through a separately reviewed
bootstrap change before migration. Do not use the dev state writer to write this
prefix or silently broaden identity/'s permission. Then the human runs
`terraform init -migrate-state` and verifies the copied state before removing the
local copy. The checked-in bootstrap root deliberately remains local for the first
bootstrap; the later backend is operator-owned and always impersonated.

## Identity root

Initialize identity/dev with protected backend parameters for bucket and
`impersonate_service_account=aw-tf-identity@PROJECT_ID.iam.gserviceaccount.com`.
The checked-in placeholder must be overridden; provider input is
`terraform_service_account` with that same account.

Review the six default runtime/CI accounts: aw-deployer, aw-web, aw-api,
aw-tool-broker, aw-workflow and aw-scheduler. aw-analytics and aw-agent are gated
off. The dev applier gets per-account serviceAccountUser; aw-deployer may attach
only web and API. Nobody receives human tokenCreator on runtime accounts.

The GitHub pool accepts only yu-iskw/agent-works. The dev principalSet additionally
requires environment dev and main; the separate plan principalSet accepts PRs or
manual-main plan events. Review WIF outputs before handing them to issue #24.
The conditional dev projectIamAdmin permits only the single runtime role allowlist,
including the exact workflow adapter custom role. Never add Owner, Editor or any
IAM administrator role. Review the condition in the console when the operator
first deploys it; offline mocks cannot prove IAM's live enforcement.

## Workload root and secret versions

Initialize environments/dev with bucket, prefix dev and backend impersonation
aw-tf-dev. Set the provider email to the same account. The root reads identity/dev
state as aw-tf-dev. Do not supply a test email fallback for a real deployment.

First review/apply the baseline APIs/audit, alerts-only budget, project roles,
Artifact Registry and secret containers with `images = {}`. Only bootstrap owns
the guard policies, so aw-tf-dev never requires orgpolicy.policyAdmin. The runtime
API set follows DESIGN section 7, with optional APIs gated by their module flags.

Yu then adds OAuth client secret and Drive worker token versions outside Terraform
using a secure input file and `--impersonate-service-account` for aw-tf-dev:

```sh
# Human only; secure input files must be outside the checkout and logs.
gcloud secrets versions add oauth-client-secret --project=PROJECT_ID --data-file=/protected/oauth-client-secret --impersonate-service-account=aw-tf-dev@PROJECT_ID.iam.gserviceaccount.com
gcloud secrets versions add drive-worker-token --project=PROJECT_ID --data-file=/protected/drive-worker-token --impersonate-service-account=aw-tf-dev@PROJECT_ID.iam.gserviceaccount.com
```

No separate writer SA or Terraform secret-version resource exists (D9). Record
numeric version identifiers in protected config. database-url is absent because
Cloud SQL is off and the pilot database stays off-cloud. If a later approved
change needs password-based SQL access, it must add only the reviewed container
and its API accessor; never put its value in state.

Issue #24 publishes the first immutable images. Supply reviewed SHA256 digests
for web/API/broker and plain non-secret env separately from pinned secret_env.
Web uses direct IAP on run.app; its IAP service agent gets invocation. API invokers
are exactly web and scheduler. Workflow invokes only the broker. Cloud Run internal
ingress requires callers to use a supported internal path; review Direct VPC egress
before cloud acceptance. D10 networking remains off until that review. Do not
open ingress or public invocation to bypass a failing probe.

The operator manages the OAuth brand/client, Workspace scopes, test users/groups,
Drive corpus and GitHub dev environment. Run the outsider 403 probe under #21;
mock plans do not prove it. Optional Cloud SQL, network/NAT, KMS, Scheduler,
BigQuery and Workflows remain off until their respective gates are approved.
Enabling SQL requires enable_network; enabling BigQuery requires the identity-root
analytics account and explicitly approved datasets. Scheduler uses HTTPS Run OIDC;
Workflows API targets need OAuth instead and must not be supplied to this OIDC job.

## Read-only plan CI

Set TF_PLAN_WIF_PROVIDER to the provider output and TF_PLAN_SA to aw-tf-plan.
Configure TF_PROJECT_ID, TF_PROJECT_NUMBER, TF_BILLING_ACCOUNT_ID and
TF_STATE_BUCKET as GitHub configuration variables for dev. Ensure the two gate
variables are also available to job-level conditions (repository/organization
configuration variables), because environment-only variables are loaded after the
job is scheduled. Without the gate variables, infra-plan.yml is skipped.

The action authenticates the direct GitHub WIF principal; Terraform's provider,
backend and identity remote-state reader impersonate aw-tf-plan. It does not require
self-tokenCreator or keys. The job runs `plan -lock=false -input=false` and never
applies, mutates IAM or writes state. Treat plan console output as restricted
infrastructure metadata. Do not put secret values in Terraform inputs.

## Final Owner removal and break-glass

After state migration and successful identity/dev and workload plan review using
impersonation, the human's final bootstrap step is removal of Yu's project Owner:

```sh
# Human only, after reviewing that scoped impersonation works.
gcloud projects remove-iam-policy-binding PROJECT_ID --member=user:yu@example.invalid --role=roles/owner
```

Replace placeholders in a protected operator context. Verify Yu can still mint
tokens only for the three Terraform accounts. The break-glass group has no standing
project authority; an approved member may impersonate aw-tf-identity for recovery.
Record incident authorization, investigate allServices audit logs, time-limit group
membership and remove it after recovery. Bootstrap maintenance or new privileged
roles need a separately reviewed recovery change; do not recreate standing Owner
or grant tokenCreator on the project.
