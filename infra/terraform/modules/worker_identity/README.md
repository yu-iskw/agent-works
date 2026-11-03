# worker_identity

Dedicated worker runtime identity, its invoker allow-list, deployer actAs, and the private artifact bucket. The human/API identity (`aw-api`) is an input and is rejected as a worker caller. No keys are created. Secret reads and registry pulls reuse the `secrets` (`accessor_emails`) and `artifact_registry` (`reader_emails`) modules.

The worker Cloud Run service must use `required_ingress` with `iap_enabled = false`; callers mint an ID token with `oidc_audience`. See docs/plans/enterprise-production-v1/fnd-05/.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. Tests in tests/ are offline mock plans.
