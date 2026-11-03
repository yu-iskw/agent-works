# OPS-02 completion evidence

- Task / owner / date / status: OPS-02, worker agent, 2026-11-04, READY_FOR_REVIEW (not VALIDATED)
- Base SHA: origin/epv1/integration at branch creation. Result SHA: see report.
- Changed files: `apps/api/src/ops-dashboard/**`, `apps/api/src/routes/ops-dashboard{,.test}.ts`, this directory. No scope exceptions.

| Criterion                                   | Test/command                                                                                                          | Result                                                     | Evidence path                                      | Local or live          | Revision   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------- | ---------------------- | ---------- |
| Counts reconcile to seeded ledger           | `ops-dashboard.test.ts` "reconcile exactly to the ledger for every scope", "segment views sum to the all view"        | PASS                                                       | `apps/api/src/ops-dashboard/ops-dashboard.test.ts` | local, real PostgreSQL | result SHA |
| Counts reconcile to approved billing sample | `reconcileBillingSample` on fixture sample only                                                                       | PASS on fixture; approved real sample AWAITING_OPERATOR    | `fixtures/billing-sample.*`                        | local fixture          | result SHA |
| Access controls hide other users' data      | `ops-dashboard.test.ts` scope tests; `routes/ops-dashboard.test.ts` cross-user, outsider, forged scope, segment admin | PASS                                                       | test files                                         | local, real PostgreSQL | result SHA |
| P08 measured                                | `meetsProvisionalTarget` on ledger and billing sample; fixture sample 97.78% (fails 99% by design)                    | PASS as a measurement; real-period value AWAITING_OPERATOR | README                                             | local                  | result SHA |
| Dollar budget remains owner-set             | `quota.limits` equals `admission_limits` rows or null (test "owner-set limits")                                       | PASS                                                       | test file                                          | local                  | result SHA |
| Alert has named responder and runbook       | `validateAlerts` fails on shipped proposal and on unset/TBD fields, passes when named                                 | PASS (validation); real responder AWAITING_OPERATOR        | `alerts.proposed.json`                             | local                  | result SHA |

- Positive controls: member, segment admin and platform admin views; filled alert; 99% billing sample.
- Negative and fault cases: forged scope, outsider, unknown body keys, duplicate/negative/fractional billing lines, empty export, tampered dashboard total (delta 7), ownerless ledger row drops attribution below target, unset alert fields.
- Migration/backward compatibility: none. 0031 not used.
- Rollback: delete the new files and route mounts.
- Open risks: execution id equality between `schedule_runs.id` and `admission_reservations.execution_id` is assumed (SCH-06 contract). Billing lines carry no timestamp, so the export is not window-filtered. `pnpm build` fails the api-contract drift check until the coordinator regenerates the contract (see README).
- Operator work still required: real billing export, named responder and runbook, alert thresholds, finance-owned budget.
- Integration validation on combined revision: not run.
