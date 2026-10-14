# cloud_run_service

One digest-pinned service with explicit execution and deployment emails. Direct IAP defaults on with ALL ingress and a required IAP agent email. Internal API/broker callers disable IAP and use INTERNAL_ONLY ingress. secret_env maps ENV names to secret_id and a positive numeric version. Optional network attaches Direct VPC egress without a connector.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
