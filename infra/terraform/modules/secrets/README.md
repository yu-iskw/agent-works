# secrets

Containers and resource IAM only. No secret values or versions enter Terraform. Replication is fixed to asia-northeast1. version_adder_emails defaults empty; Yu writes versions by impersonating aw-tf-dev (D9).

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
