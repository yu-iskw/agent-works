# network

Explicit VPC/subnet for Direct VPC egress. Optional Cloud NAT is limited to that subnet. Root defaults off; no VPC connector or default network. Cloud Run consumes direct_vpc_egress.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
