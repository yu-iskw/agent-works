# github_wif

Repository fixed to yu-iskw/agent-works. attribute.access separates dev deployment on main from PR/manual-main plan. The identity root binds principalSets to the appropriate access attribute. Environment dev and the repository condition both gate deployer federation.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
