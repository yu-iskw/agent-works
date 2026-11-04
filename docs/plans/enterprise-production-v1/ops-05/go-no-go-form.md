# Go/no-go owner form

Template. One form per gate, cohort and optional capability. It is not an approval until a named human fills and signs it. An agent may prepare it; an agent may never sign it. A closed issue or a green check never substitutes for it.

## Binding

- Gate: G1 / G2 / G3 / G4
- Cohort and capability scope:
- Source SHA:
- Image digest(s), `name@sha256:...`:
- Migration version (highest applied) and list digest:
- Policy/config revisions (gate-config, manifest, invariant map):
- Test/evaluation corpus version and thresholds record (approved, not `UNAPPROVED_PLACEHOLDER`):
- Evidence bundle digest (`bundleDigest` from `scripts/ops-05/build-bundle.mjs`):
- SBOM reference and security findings status (every finding PASS, or an unexpired exception per `fnd-06/release-evidence-policy.md` section 5):
- Stage gate record: link to the filled `templates/stage-gate.md`, verdict:

## Checklist (all must be yes for GO)

| Check                                                                            | Yes / No | Evidence |
| -------------------------------------------------------------------------------- | -------- | -------- |
| Every mandatory task integrated and its live checks attached or explicitly DEFER |          |          |
| Security corpus zero failures, owner and cross-user controls pass                |          |          |
| No unaccounted privileged effects                                                |          |          |
| Restore drill passed (RTO/RPO met)                                               |          |          |
| Authority evidence present for the exercised effects                             |          |          |
| Rollback rehearsed for this exact revision and migration version                 |          |          |
| Optional capabilities DEFER with disabled behavior proved                        |          |          |
| Residual risks recorded with owner and expiry                                    |          |          |
| Open decisions this gate depends on are accepted (see `decisions-status.md`)     |          |          |

## Verdict

- Verdict: GO / NO-GO / AWAITING_EVIDENCE
- Reasons if not GO:
- Approvers required by gate: G1 security, platform, product. G2 platform, security, product. G3 product, security, privacy. G4 SRE, security, product, finance.

| Role | Name | Approval reference | Timestamp |
| ---- | ---- | ------------------ | --------- |
|      |      |                    |           |

- Scope and expiry of this approval (cohort, revision, date):
- Stop conditions and who may invoke them:
- Incident and support owner:

Any blank above is a blocker. Approval covers only the listed cohort and revision.
