# cloud_sql

D1 keeps the pilot database off-cloud. If explicitly enabled with network, this provisions private-IP Postgres 16 with IAM DB users, regional availability, PITR and enforced encrypted connections. No passwords or authorized networks. Caller uses project_iam for cloudsql.client and instanceUser.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. The caller configures the impersonating provider. No identities or keys are created. IAM outputs expose member, role and scope for review. See variables.tf for the complete typed interface and tests/ for offline mock plans.
