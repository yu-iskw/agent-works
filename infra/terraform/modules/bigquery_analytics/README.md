# bigquery_analytics

Approved datasets only, read-only dataViewer on each. jobUser is delegated to project_iam; no data roles on the project. Disabled by default.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
