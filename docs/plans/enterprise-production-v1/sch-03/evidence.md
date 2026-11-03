# Task completion evidence

- Task / owner / date / status: SCH-03, worker, 2026-11-03, READY_FOR_REVIEW (local only)
- Base SHA / result SHA / draft PR: base `origin/epv1/integration`; result SHA in the report; no PR
- Changed files and scope exceptions: new only. `apps/api/src/queue/**`, `infra/terraform/modules/task_queue/**`, `docs/plans/enterprise-production-v1/sch-03/**`

| Criterion                                               | Test/command                                                                             | Result                                                      | Evidence path           | Local or live | Revision   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- | ------------- | ---------- |
| Wrong identity/audience/issuer/expiry/no token rejected | `vitest run apps/api/src/queue/worker-delivery.test.ts` (locally generated RSA keys)     | PASS                                                        | worker-delivery.test.ts | local         | result SHA |
| Valid envelope resolved through the DB port             | same file, handoff tests                                                                 | PASS (port fake, no Postgres)                               | worker-delivery.test.ts | local         | result SHA |
| Duplicate terminal delivery acknowledged                | same file                                                                                | PASS                                                        | worker-delivery.test.ts | local         | result SHA |
| No 2xx before durable handoff                           | same file; failing port yields 503                                                       | PASS                                                        | worker-delivery.test.ts | local         | result SHA |
| Stable names, OIDC config, deadline, backoff            | `vitest run apps/api/src/queue/cloud-tasks.test.ts`                                      | PASS                                                        | cloud-tasks.test.ts     | local         | result SHA |
| Terraform module                                        | `terraform fmt -check` in relaxed scratch copy (`required_version` only relaxed, 1.10.3) | fmt PASS; validate UNTESTED (no provider available offline) | n/a                     | local         | result SHA |
| Real queue delivery                                     | operator-real-queue-test.md                                                              | AWAITING_OPERATOR                                           | n/a                     | live          | n/a        |

- Negative and fault cases: see test names (401/403 matrix, verifier unavailable, poison, v2 deferral, store failure, enqueue 4xx/5xx/transport).
- Migration/backward compatibility: none; additive, unwired.
- Rollback: delete the new files.
- Open risks: `DeliveryStore` is only a port; Postgres-backed handoff and fencing are not proven here (needs the SCH-01/02 tables). The live Google cert format is assumed from the public JWKS shape (RSA, `kid`); not fetched.
- Operator work still required: operator-real-queue-test.md.
