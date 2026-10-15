# Terraform dev infrastructure

[DESIGN.md](DESIGN.md) is the approved design. Terraform is
pinned to >=1.16.5,<1.17.0 and the GA Google provider to 8.5.0.

Three rules apply throughout:

1. Modules never create identities. They accept existing service-account emails.
2. A separate account handles each responsibility. Only `bootstrap/` and
   `identity/dev/` create accounts; conditional analytics and agent accounts are off.
3. Impersonation is mandatory for both providers and GCS state. Bootstrap is the
   one provider exception because it creates the initial accounts. Keys are forbidden.

| Root                | Execution identity                    | Responsibility                                                                                                                                                          |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`        | Human operator, initially local state | Adopted project (`data "google_project"`), opt-in guard/audit/deprivilege/billing switches, state bucket, aw-tf-identity/dev/plan, conditioned dev IAM and custom roles |
| `identity/dev/`     | aw-tf-identity                        | Runtime accounts, attach bindings, WIF (`deploy-dev.yml` vs `infra-plan.yml` pinned by `job_workflow_ref` on `refs/heads/main`)                                         |
| `environments/dev/` | aw-tf-dev (aw-tf-plan in plan CI)     | Modules for workload foundations and runtime services                                                                                                                   |

`modules/environment` is retired. `project_baseline` hardens an existing project;
bootstrap alone sets its guard and default-account inputs (both opt-in for adopted projects). `budget` is alerts
only (opt-in via `enable_budget`), and `project_iam` owns additive standard project grants; bootstrap custom provisioning grants are colocated with their roles. Bootstrap owns the Workflows custom adapter role; the Workflows module assigns it. Resource IAM lives beside each resource.

Dev reads the identity email map using impersonated `terraform_remote_state`.
Supplying `service_account_emails` bypasses that data source for offline tests.
Every optional module defaults off. `images = {}` creates foundations without Run
revisions, supporting the design's two-pass rollout. Supply digest-pinned `web`,
`api` and `tool_broker` entries after operator secret setup and image publication.
Web uses direct IAP and its service agent; API and broker use internal ingress and
explicit SA invokers. Web/API images require networking with Direct VPC ALL_TRAFFIC and Private Google Access. Enable matching bootstrap flags first for optional provisioning permissions and the Workflows adapter role. Cloud SQL
requires networking and stays disabled for the off-cloud pilot database (D1).

Use only `terraform.tfvars.example` as tracked operator templates. All ids and
addresses in examples are placeholders. Secret values never enter Terraform:
`secrets` manages containers/accessor IAM and `secret_env` pins numeric versions.
OAuth brand/client, Workspace membership, secret values and cloud acceptance stay
manual. See [the bootstrap runbook](../../docs/runbooks/terraform-bootstrap.md).

## Offline verification

No cloud credentials are needed or permitted for these commands. Never run an
apply or initialize a real backend as an agent. Do not run Trunk for this bundle.

```sh
terraform -chdir=infra/terraform fmt -check -recursive
for root in infra/terraform/bootstrap infra/terraform/identity/dev infra/terraform/environments/dev infra/terraform/modules/*; do
  terraform -chdir="$root" init -backend=false -input=false
  terraform -chdir="$root" validate
  terraform -chdir="$root" test
done
tflint --chdir=infra/terraform --recursive
node --test infra/terraform/evidence.test.mjs
```

All Terraform tests use mock Google providers and plan commands. The evidence
suite checks identity boundaries, pins, impersonation and the inert plan workflow;
it injects an unexported identity into a temporary module as a negative control.
`node infra/terraform/evidence.mjs` additionally verifies the retained Terraform
Owner/key negative controls and writes results under `evidence-artifacts/`.

The new plan workflow is skipped until `TF_PLAN_WIF_PROVIDER` and `TF_PLAN_SA` are
set. When configured, direct GitHub WIF supplies source credentials and the provider
and state backend impersonate aw-tf-plan. There is no extra self-impersonation hop.
Only read-only plan runs there; it never applies or uploads plans/state. Runtime
configuration continues to name aw-tf-dev as the applier even while the executing
provider impersonates aw-tf-plan, so a plan cannot substitute the read-only account
into workload deployment grants.
