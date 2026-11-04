# task_queue

Cloud Tasks queue for authenticated dispatch (SCH-03). The dispatcher service account enqueues, mints the OIDC token and is the only `run.invoker` on the worker; no public invoker. Retry, backoff and concurrency caps are variables. The per-task dispatch deadline (below 30 minutes) is set by the application adapter.

Requires Terraform >=1.16.5,<1.17.0 and hashicorp/google 8.5.0. No identities or keys are created. IAM outputs expose member, role and scope for review. Not wired into any root.
