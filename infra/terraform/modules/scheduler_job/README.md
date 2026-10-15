# scheduler_job

OIDC authenticated HTTPS POST, attached to the supplied scheduler email. Caller grants invocation at its chosen Run service or workflow. Root opt-in defaults false.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
