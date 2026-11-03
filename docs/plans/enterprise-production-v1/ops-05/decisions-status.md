# Open decisions status

Generated from [fnd-01/readiness-matrix.json](../fnd-01/readiness-matrix.json) (recorded 2026-11-02, base 8d2dc6d) by `node scripts/ops-05/render-index.mjs`. Rule: A decision is accepted only with a real signoff and an Accepted ADR. Everything else stays open. Placeholders are not signoffs.

A release record cannot cite a decision as accepted unless the matrix says so. Rendering never changes a status.

## D-01 to D-12

| ID   | Question                                                           | Owner role                         | Status | Blocks unrestricted production | Open items | Signoff |
| ---- | ------------------------------------------------------------------ | ---------------------------------- | ------ | ------------------------------ | ---------- | ------- |
| D-01 | Legal residency and processing regions                             | Security / privacy                 | open   | yes                            | O02        | none    |
| D-02 | Pilot users, tenancy and sensitivity                               | Product / data owners              | open   | yes                            | O01        | none    |
| D-03 | Priority data sources                                              | Product / integration owners       | open   | yes                            | O08        | none    |
| D-04 | Gemini Enterprise licensing vs Agent Platform custom approach      | Procurement / architecture         | open   | yes                            | O06, O08   | none    |
| D-05 | Source ACL freshness and revocation requirements                   | Security / source owner            | open   | yes                            | none       | none    |
| D-06 | Agent Gateway / Registry availability for selected topology        | Platform / security                | open   | yes                            | O03, O07   | none    |
| D-07 | OAuth scope / consent workflow                                     | Workspace administrators           | open   | yes                            | O03        | none    |
| D-08 | Exact audit/retention and deletion rules                           | Legal / governance                 | open   | yes                            | O02        | none    |
| D-09 | Allowed model families and inference endpoints                     | AI governance                      | open   | yes                            | O02, O08   | none    |
| D-10 | Workload size and availability objectives                          | Product / SRE                      | open   | no                             | O05        | none    |
| D-11 | Whether agents may create/schedule work without direct user prompt | Business / security                | open   | no                             | O04        | none    |
| D-12 | Operations that need dual approval                                 | Security / business control owners | open   | no                             | O04        | none    |

## O01 to O08

| ID  | Decision                                                                                              | Owner role                 | Status | Blocks                            | Related D        | Signoff |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------- | ------ | --------------------------------- | ---------------- | ------- |
| O01 | Enterprise/segment/team isolation mapping; preserve current separate segment DBs or approve migration | Architecture + security    | open   | Cross-segment persistence changes | D-02             | none    |
| O02 | Approved region and data/model processing residency, source retention/deletion                        | Privacy + platform         | open   | Live rollout; managed memory      | D-01, D-08, D-09 | none    |
| O03 | IAP topology and machine invocation identities; scoped OAuth consent                                  | Security + Workspace admin | open   | DEP-01 and live writes            | D-06, D-07       | none    |
| O04 | Delegation scopes, depth, lifetime, scheduling rights and approval exemptions                         | Security + product         | open   | AGT-03 activation, SCH-04         | D-11, D-12       | none    |
| O05 | SLO/RTO/RPO, budget ceiling, support hours and incident owner                                         | SRE + product + finance    | open   | Production approval               | D-10             | none    |
| O06 | Existing Cloud Workflows role vs database state machine/Cloud Tasks                                   | Architecture               | open   | SCH-00 contract freeze            | D-04             | none    |
| O07 | Connector runtime health/version enforcement and service ownership                                    | Connector owner + security | open   | Any out-of-process connector      | D-06             | none    |
| O08 | Exact provider support/SDK/region/quotas/cost                                                         | Platform                   | open   | Optional managed capabilities     | D-03, D-04, D-09 | none    |

Open: 12 of 12 decisions, 8 of 8 open items.
