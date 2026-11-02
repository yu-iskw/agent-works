<!-- Generated from readiness-matrix.json by scripts/fnd-01/render-readiness-matrix.mjs. Do not edit. -->

# FND-01 governance readiness matrix

Recorded 2026-11-02 on base `8d2dc6d3b602a4b30a9a7b4c2f0809eb4b291dcc`. This file approves nothing.

## Rule

A decision is accepted only with a real signoff and an Accepted ADR. Everything else stays open. Placeholders are not signoffs.

## ADRs

| Id   | File                                                       | Status   |
| ---- | ---------------------------------------------------------- | -------- |
| 0001 | docs/adr/0001-typescript-first-with-adk-js.md              | Accepted |
| 0002 | docs/adr/0002-monorepo-layout.md                           | Accepted |
| 0003 | docs/adr/0003-pilot-decisions.md                           | Accepted |
| 0004 | docs/adr/0004-application-core-and-adapter-boundaries.md   | Proposed |
| 0005 | docs/adr/0005-agent-runtime-package.md                     | Proposed |
| 0006 | docs/adr/0006-curated-marketplace-and-connector-gateway.md | Proposed |

## Issue #23 (C-05 Record the cloud gate decisions, CLOSED)

Closure is not evidence of decisions. Neither promised ADR exists, and ADR numbers 0004 and 0005 now name different Proposed ADRs. controls.yaml holds test ownership only, with no D-id cross-reference or signoff.

## Decisions

| Id   | Question                                                           | Owner role                         | Status | Blocks prod | Blocking capability                                                                           | Open items | Note                                                                                                                              |
| ---- | ------------------------------------------------------------------ | ---------------------------------- | ------ | ----------- | --------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | Legal residency and processing regions                             | Security / privacy                 | open   | yes         | Live rollout outside the dev project; managed memory; regional model inference                | O02        | ADR 0003 fixes the dev pilot region asia-northeast1 only. It is not a production residency decision.                              |
| D-02 | Pilot users, tenancy and sensitivity                               | Product / data owners              | open   | yes         | Any user population beyond the test tenant; cross-segment persistence changes                 | O01        | ADR 0003 names a test tenant with Alice, Bob and a reviewer group. No classification or named production teams are recorded.      |
| D-03 | Priority data sources                                              | Product / integration owners       | open   | yes         | Retrieval over any real source; source-backed answers in production                           | O08        | ADR 0003 builds no retrieval and names a Google Docs draft as the first write target. No source inventory or quotas are recorded. |
| D-04 | Gemini Enterprise licensing vs Agent Platform custom approach      | Procurement / architecture         | open   | yes         | Choice of managed retrieval arm; managed service adoption                                     | O06, O08   | ADR 0003 only says arm B runs if there is no Gemini Enterprise trial. The promised managed-services ADR does not exist.           |
| D-05 | Source ACL freshness and revocation requirements                   | Security / source owner            | open   | yes         | Source-access preservation through reads, citations and memory (SEC-02); ACL-01 live evidence | none       | No O item covers it. The measurement belongs to ACL-01.                                                                           |
| D-06 | Agent Gateway / Registry availability for selected topology        | Platform / security                | open   | yes         | Any dependency on Agent Gateway or Registry; out-of-process connectors                        | O03, O07   | Deny-by-default integration test and region check are not recorded.                                                               |
| D-07 | OAuth scope / consent workflow                                     | Workspace administrators           | open   | yes         | DEP-01 and every live Workspace write scope                                                   | O03        | No admin approval or security verification is recorded.                                                                           |
| D-08 | Exact audit/retention and deletion rules                           | Legal / governance                 | open   | yes         | Retention and deletion enforcement (P3-RET); source retention; managed memory                 | O02        | No records schedule or privacy assessment is recorded.                                                                            |
| D-09 | Allowed model families and inference endpoints                     | AI governance                      | open   | yes         | Production model selection; regional inference endpoints                                      | O02, O08   | ADR 0003 sets the pilot region only. No benchmark, terms or price review is recorded.                                             |
| D-10 | Workload size and availability objectives                          | Product / SRE                      | open   | no          | Promotion of provisional targets P01-P08 to approved SLOs; production approval                | O05        | RFC section 1.3 states no throughput, RTO or RPO was supplied. Pack targets are provisional.                                      |
| D-11 | Whether agents may create/schedule work without direct user prompt | Business / security                | open   | no          | AGT-03 activation; SCH-04; agent-created routines                                             | O04        | No delegation charter or revocation semantics are recorded.                                                                       |
| D-12 | Operations that need dual approval                                 | Security / business control owners | open   | no          | Approval exemptions; sensitive effects that require dual approval                             | O04        | No risk classification or separation-of-duties policy is recorded.                                                                |

## Open items

| Id  | Open decision                                                                                         | Owner role                 | Status | Blocking capability               | Related D        |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------- | ------ | --------------------------------- | ---------------- |
| O01 | Enterprise/segment/team isolation mapping; preserve current separate segment DBs or approve migration | Architecture + security    | open   | Cross-segment persistence changes | D-02             |
| O02 | Approved region and data/model processing residency, source retention/deletion                        | Privacy + platform         | open   | Live rollout; managed memory      | D-01, D-08, D-09 |
| O03 | IAP topology and machine invocation identities; scoped OAuth consent                                  | Security + Workspace admin | open   | DEP-01 and live writes            | D-06, D-07       |
| O04 | Delegation scopes, depth, lifetime, scheduling rights and approval exemptions                         | Security + product         | open   | AGT-03 activation, SCH-04         | D-11, D-12       |
| O05 | SLO/RTO/RPO, budget ceiling, support hours and incident owner                                         | SRE + product + finance    | open   | Production approval               | D-10             |
| O06 | Existing Cloud Workflows role vs database state machine/Cloud Tasks                                   | Architecture               | open   | SCH-00 contract freeze            | D-04             |
| O07 | Connector runtime health/version enforcement and service ownership                                    | Connector owner + security | open   | Any out-of-process connector      | D-06             |
| O08 | Exact provider support/SDK/region/quotas/cost                                                         | Platform                   | open   | Optional managed capabilities     | D-03, D-04, D-09 |
