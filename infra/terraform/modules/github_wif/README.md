# github_wif

Repository fixed to yu-iskw/agent-works. `attribute.job_workflow_ref` and `attribute.access` pin federation on `refs/heads/main` to `.github/workflows/deploy-dev.yml` (environment `dev`, including `workflow_dispatch`, mapped to `dev`) and `.github/workflows/infra-plan.yml` (PR or `workflow_dispatch` on `main`, mapped to `plan`). The identity root binds principalSets to the appropriate access attribute. Environment `dev`, workflow ref and the repository condition all gate deployer federation.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
