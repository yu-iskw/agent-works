# enterprise-production-v1 plan folder

Index of the implementation-pack work. Every task is local, READY_FOR_REVIEW at most, and not VALIDATED. Live criteria are AWAITING_OPERATOR. Start with the release records, then the per-task folders.

## Release records (OPS-05)

| Record                                                                                                                 | Purpose                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [ops-05/gates/G1.md](ops-05/gates/G1.md), [G2](ops-05/gates/G2.md), [G3](ops-05/gates/G3.md), [G4](ops-05/gates/G4.md) | Stage gate records from the OPS-03 gate logic fed with real statuses. All NO-GO today.               |
| [ops-05/operator-action-index.md](ops-05/operator-action-index.md)                                                     | Every AWAITING_OPERATOR item by gate, with the approval template                                     |
| [ops-05/rollout-rollback.md](ops-05/rollout-rollback.md)                                                               | Cohort rollout, flags default off, rollback or forward repair for migrations 0024..0030, DEFER proof |
| [ops-05/go-no-go-form.md](ops-05/go-no-go-form.md)                                                                     | Owner go/no-go form template                                                                         |
| [ops-05/residual-risk-register.md](ops-05/residual-risk-register.md)                                                   | Open risks with owner and expiry placeholders                                                        |
| [ops-05/decisions-status.md](ops-05/decisions-status.md)                                                               | D-01..D-12 and O01..O08 from the FND-01 matrix                                                       |
| [ops-05/evidence.md](ops-05/evidence.md)                                                                               | OPS-05 task evidence                                                                                 |

Tools: `scripts/ops-05/build-bundle.mjs` (immutable evidence bundle), `render-gates.mjs`, `render-index.mjs`. Issue 175 stays the narrow release gate; nothing here replaces it.

## Tasks by gate

| Gate                       | Task folders                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Secure controlled pilot | [fnd-01](fnd-01/evidence.md), [fnd-03](fnd-03/evidence.md), [fnd-05](fnd-05/evidence.md), [fnd-06](fnd-06/release-evidence-policy.md), [dep-01](dep-01/evidence.md), [acl-01](acl-01/evidence.md), [ops-01](ops-01/evidence.md). Not present on the integration head: BASE-00, FND-02, FND-04, AUTH-01, TASK-01 (see [AUTH-01 follow-up](auth-01-teamwork-gateway-followup.md)) |
| G2 Durable automation      | [sch-00](sch-00/evidence.md), [sch-01](sch-01/evidence.md), [sch-02](sch-02/evidence.md), [sch-03](sch-03/evidence.md), [sch-04](sch-04/evidence.md), [sch-05](sch-05/evidence.md), [sch-06](sch-06/evidence.md), [agt-03](agt-03/evidence.md)                                                                                                                                  |
| G3 Governed teamwork       | [agt-00](agt-00/evidence.md), [agt-01](agt-01/evidence.md), [agt-02](agt-02/evidence.md), [agt-03](agt-03/evidence.md), [agt-04](agt-04/evidence.md), [agt-05](agt-05/evidence.md), [agt-06](agt-06/evidence.md), [agt-07](agt-07/evidence.md)                                                                                                                                  |
| G4 Enterprise production   | [ops-02](ops-02/evidence.md), [ops-03](ops-03/evidence.md), [ops-04](ops-04/evidence.md), [ops-05](ops-05/evidence.md)                                                                                                                                                                                                                                                          |

## Related

- Runbooks: `docs/runbooks/` (deploy-dev, dr-restore, global-agent-stop, capacity-campaign).
- Readiness matrix: [fnd-01/readiness-matrix.md](fnd-01/readiness-matrix.md) and the older `docs/plans/phase3-readiness-matrix.md`.
- ADRs: `docs/adr/README.md`. Proposed ADRs are not decisions.
