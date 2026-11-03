# Task completion evidence

- Task / owner / date / status: FND-05, worker, 2026-11-03, READY_FOR_REVIEW (local only)
- Base SHA / result SHA / draft PR: base `1f76ea4` (origin/epv1/integration); result SHA in the report; no PR
- Changed files and scope exceptions: new only, no existing file edited. `infra/terraform/modules/worker_identity/**`, `apps/api/src/auth/service-identity*.ts`, `scripts/fnd-05/**`, `docs/plans/enterprise-production-v1/fnd-05/**`

| Criterion                                              | Test/command                                                                                                                                 | Result                                  | Evidence path                       | Local or live | Revision   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- | ------------- | ---------- |
| No static key or secret in repo/plan artifacts         | `node scripts/fnd-05/check-identity-controls.mjs` and `vitest run scripts/fnd-05`                                                            | PASS                                    | check-identity-controls.test.mjs    | local         | result SHA |
| Wrong worker principal/audience/issuer/expiry rejected | `vitest run apps/api/src/auth/service-identity.test.ts`                                                                                      | PASS                                    | service-identity.test.ts            | local         | result SHA |
| IAP/worker separation documented                       | review                                                                                                                                       | PASS                                    | identity-and-credential-controls.md | local         | result SHA |
| No public invocation in IAM plan                       | checker public-invoker rule and module validation tests                                                                                      | PASS                                    | tests above, `terraform test`       | local         | result SHA |
| Terraform module valid                                 | `terraform fmt -check`, `validate`, `test` in relaxed scratch copy (pinned 1.16.5 unavailable, 1.10.3 used, only `required_version` relaxed) | PASS (relaxed copy, not pinned version) | n/a                                 | local         | result SHA |
| Live direct URL, wrong audience, unauthorized SA       | operator OP-1                                                                                                                                | AWAITING_OPERATOR                       | n/a                                 | live          | n/a        |

- Positive controls: authorized caller accepted; repo scan clean.
- Negative and fault cases: see rejection matrix in the control doc.
- Migration/backward compatibility: none; additive, unwired.
- Rollback or forward repair: delete the module (see control doc).
- Open risks / decisions / follow-up owner: retention and logging settings; ID-token signature verification wiring (RS256 Google certs) still to be added where the worker route is mounted.
- Operator work still required: OP-0..OP-4 in the control doc.
