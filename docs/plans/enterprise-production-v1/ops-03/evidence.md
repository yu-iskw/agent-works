# OPS-03 evidence

Base: origin/epv1/integration. All results are local/offline. No live evidence exists; every live row is AWAITING_OPERATOR.

## What changed

- Holdout extended 54 to 74 rows (dataset 1.0.0 to 1.1.0, `evals/v1/manifest.json`). `scripts/ops-03/extend-holdout.mjs` derives security variants from adversarial rows (ids renamed, numeric markers rotated) and is idempotent.
- `tools/evals/holdout-classes.mjs`: the six required classes (source attribution, quality, prompt injection, tool misuse, approval replay, cross-user leak), each must have holdout cases.
- `tools/evals/invariant-map.json` + `invariant-check.mjs`: SEC-01..04, DUR-01..03, GOV-01, OBS-01 mapped to deterministic tests and a live/operator item. Checker fails on an unmapped invariant, no deterministic test, a missing file, a path escape, or no live item.
- `tools/evals/release-report.mjs`: records model, dataset version and fingerprints, judge, source SHA, image digests. Refuses an offline fixture labeled live. Absent invariant evidence is written as UNTESTED.
- `tools/evals/stage-gate.mjs`: verdict and `templates/stage-gate.md` rendering. `scripts/ops-03/stage-gate.mjs` is the CLI.
- Edited existing: count assertions in `tools/evals/dataset.test.mjs` and `scripts/release-gate.test.mjs` (156 to 176, 54 to 74).

## Gate rules

Security FAIL gives NO-GO whatever quality says. Else any UNTESTED, undeclared DEFER, missing binding (model, judge, image digest) or missing approver gives AWAITING_EVIDENCE. Quality is consulted last and can only add a NO-GO. Quality stays UNTESTED while `gate-config.json` thresholds are UNAPPROVED_PLACEHOLDER.

## Acceptance mapping

| Criterion                                   | Test                                                                                                            | Mode  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| Missing evidence or security failure blocks | `scripts/ops-03/ops-03.test.mjs` "high quality with one leak is NO-GO", "missing evidence is AWAITING_EVIDENCE" | local |
| No offline fixture labeled live             | "refuses an offline fixture labeled live", CLI-core refusal test                                                | local |
| Results bind model/dataset/SHA/digest       | "states UNTESTED ... records bindings", invalid-binding cases                                                   | local |
| Every invariant mapped                      | "committed map covers every invariant", negative checker tests                                                  | local |
| Holdout classes                             | "every release class has holdout cases", manifest test                                                          | local |
| Live observations                           | AWAITING_OPERATOR, see operator items in `invariant-map.json` `live.operatorEvidence`                           | live  |

## Known gaps

- DUR-02 has no dedicated forced-lease-expiry fencing test (`coverage: partial` in the map).
- Pre-existing: `node scripts/release-gate.mjs` already fails on the base (citationPrecision unavailable, groundingCoverage floor); the 18 original holdout grounding rows return `error` under the offline runner. The 20 new rows pass and security counters are 0.
- `scripts/release-gate.mjs` still writes dataset version `1.0.0` in its result; the OPS-03 report reads the manifest instead. Not edited (outside write set).
- `docs/evals/README.md` still says 156 cases.
