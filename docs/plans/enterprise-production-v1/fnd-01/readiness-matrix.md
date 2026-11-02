# FND-01 governance readiness matrix

Status: READY_FOR_REVIEW (local, docs and one test). Recorded 2026-11-02 on base `8d2dc6d3b602a4b30a9a7b4c2f0809eb4b291dcc`.

The machine-readable source is [`readiness-matrix.json`](readiness-matrix.json). The executable check is `tools/fnd-01/fnd-01-readiness.test.mjs`. This file explains them. It approves nothing.

## Rule

A decision is accepted only with a named signoff and an Accepted ADR. No signoff exists for any D or O item in the repository, so all twenty stay open. Proposed ADRs 0004, 0005 and 0006 stay Proposed. A placeholder such as TBD, pending or an empty name is not a signoff, and the test fails if one is treated as approval.

## Sources reconciled

- `docs/plans/phase3-readiness-matrix.md`, decision table D-01 to D-12. Every row reads `open`.
- `decisions.tsv`. It is a run log of delivery steps (H0-04, H0-05) and holds no D-id record. Nothing in it changes a decision status.
- `docs/adr/0001` to `0003` (Accepted) and `0004` to `0006` (Proposed).
- Closed issue #23 (C-05, closed 2026-10-13).
- Pack `specs/08-decisions-and-risks.md` for O01 to O08.

## Issue #23 reconciliation

#23 promised `docs/adr/0004-managed-services-adoption.md`, `docs/adr/0005-retrieval-arm.md` and cross-references in `docs/security/controls.yaml`. Its acceptance said D-01 to D-09 stay separately identified and not cleared.

- Neither ADR file exists. ADR numbers 0004 and 0005 now belong to unrelated Proposed ADRs (application core boundaries, agent runtime package).
- `controls.yaml` maps threats to tests and owners. It has no D-id cross-reference and no signoff.
- `docs/plans/phase3-readiness-matrix.md` states that no Accepted ADR is keyed to any D-id.

The closure is therefore not evidence that any cloud-gate decision was recorded. The only binding record is ADR 0003, which covers the dev pilot (region `asia-northeast1`, test tenant, no retrieval, no write tool, no spend cap) and states that production hard stops are decided by a later record. The matrix lists ADR 0003 as a partial record for D-01 to D-04 and keeps those rows open.

## Decisions D-01 to D-12

Owner roles and questions come from the Phase 3 decision table. "Blocking capability" is this task's mapping of what stays disabled while the row is open. It is inferred from the Phase 3 matrix and the pack, not a recorded decision. "Blocks prod" is the Phase 3 matrix column.

| Id   | Question                                                      | Owner role                         | Status | Blocks prod | Blocking capability                                             | Evidence path                                               | Open items |
| ---- | ------------------------------------------------------------- | ---------------------------------- | ------ | ----------- | --------------------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| D-01 | Legal residency and processing regions                        | Security / privacy                 | open   | yes         | Live rollout outside dev; managed memory; regional inference    | `docs/plans/phase3-readiness-matrix.md` (partial: ADR 0003) | O02        |
| D-02 | Pilot users, tenancy and sensitivity                          | Product / data owners              | open   | yes         | Users beyond the test tenant; cross-segment persistence changes | same (partial: ADR 0003)                                    | O01        |
| D-03 | Priority data sources                                         | Product / integration owners       | open   | yes         | Retrieval over real sources                                     | same (partial: ADR 0003)                                    | O08        |
| D-04 | Gemini Enterprise licensing vs Agent Platform custom approach | Procurement / architecture         | open   | yes         | Managed retrieval arm; managed service adoption                 | same (partial: ADR 0003)                                    | O06, O08   |
| D-05 | Source ACL freshness and revocation requirements              | Security / source owner            | open   | yes         | SEC-02 source-access preservation; ACL-01 live evidence         | same                                                        | none       |
| D-06 | Agent Gateway / Registry availability                         | Platform / security                | open   | yes         | Gateway or Registry dependency; out-of-process connectors       | same                                                        | O03, O07   |
| D-07 | OAuth scope / consent workflow                                | Workspace administrators           | open   | yes         | DEP-01; every live Workspace write scope                        | same                                                        | O03        |
| D-08 | Exact audit/retention and deletion rules                      | Legal / governance                 | open   | yes         | Retention and deletion enforcement; managed memory              | same                                                        | O02        |
| D-09 | Allowed model families and inference endpoints                | AI governance                      | open   | yes         | Production model selection; regional endpoints                  | same                                                        | O02, O08   |
| D-10 | Workload size and availability objectives                     | Product / SRE                      | open   | no          | Promotion of P01 to P08 to approved SLOs; production approval   | same                                                        | O05        |
| D-11 | Agents creating or scheduling work without a user prompt      | Business / security                | open   | no          | AGT-03 activation; SCH-04                                       | same                                                        | O04        |
| D-12 | Operations that need dual approval                            | Security / business control owners | open   | no          | Approval exemptions; dual-approval effects                      | same                                                        | O04        |

D-05 has no O item. Its evidence comes from ACL-01 measurements, so it has no decision owner thread in the pack.

## Open items O01 to O08

Status of every row: open, no signoff recorded. Evidence for the open state is this matrix and pack `specs/08-decisions-and-risks.md`.

| Id  | Open decision                                                                             | Owner role                 | Blocking capability               | Related D        |
| --- | ----------------------------------------------------------------------------------------- | -------------------------- | --------------------------------- | ---------------- |
| O01 | Enterprise/segment/team isolation mapping; keep separate segment DBs or approve migration | Architecture + security    | Cross-segment persistence changes | D-02             |
| O02 | Approved region, data and model processing residency, source retention/deletion           | Privacy + platform         | Live rollout; managed memory      | D-01, D-08, D-09 |
| O03 | IAP topology, machine invocation identities, scoped OAuth consent                         | Security + Workspace admin | DEP-01 and live writes            | D-06, D-07       |
| O04 | Delegation scopes, depth, lifetime, scheduling rights, approval exemptions                | Security + product         | AGT-03 activation, SCH-04         | D-11, D-12       |
| O05 | SLO/RTO/RPO, budget ceiling, support hours, incident owner                                | SRE + product + finance    | Production approval               | D-10             |
| O06 | Cloud Workflows role vs database state machine and Cloud Tasks                            | Architecture               | SCH-00 contract freeze            | D-04             |
| O07 | Connector runtime health/version enforcement and service ownership                        | Connector owner + security | Any out-of-process connector      | D-06             |
| O08 | Exact provider support, SDK, region, quotas, cost                                         | Platform                   | Optional managed capabilities     | D-03, D-04, D-09 |

The D to O links are this task's mapping by topic. The pack does not state them. A reviewer who disagrees edits the JSON, and the test checks both directions agree.

## ADR status

| ADR              | Repo status | Matrix status |
| ---------------- | ----------- | ------------- |
| 0001, 0002, 0003 | Accepted    | Accepted      |
| 0004, 0005, 0006 | Proposed    | Proposed      |

The test reads each ADR file's `## Status` line and fails if the matrix and the file differ.

## Compatibility and rollback

Docs and one test file only. No migration, schema, lockfile, workflow or ADR is touched. Rollback is `git revert` of the FND-01 commit.
