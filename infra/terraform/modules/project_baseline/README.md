# project_baseline

Hardens an existing project. apis is explicit; bootstrap alone supplies guard_constraints and deprivilege_default_accounts=true. Dev supplies APIs and audit configuration only.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
