# OPS-05 evidence

- Task / owner / date / status: OPS-05 / worker agent / 2026-11-04 / READY_FOR_REVIEW (not VALIDATED). Live criteria AWAITING_OPERATOR.
- Base SHA / result SHA / draft PR: `b322e7d` (`origin/epv1/integration`) / see branch `epv1/ops-05-release` head / none (no push).
- Changed files: `scripts/ops-05/**`, `docs/plans/enterprise-production-v1/ops-05/**`, `docs/plans/enterprise-production-v1/README.md`. No migration, no edit outside the write set.

| Criterion                                                                               | Test/command                                                                                      | Result                    | Evidence path                    | Local or live | Revision    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------- | ------------- | ----------- |
| Immutable bundle with file hashes, migrations, config, corpus, security, deferred proof | `pnpm exec vitest run --project scripts scripts/ops-05` (exit 0, 27 tests)                        | PASS                      | `scripts/ops-05/ops-05.test.mjs` | local         | branch head |
| Offline result never labeled live                                                       | "refuses an offline-provenance result labeled live", "refuses a live label with no live evidence" | PASS                      | same                             | local         | branch head |
| Known failing minimatch advisory recorded FAIL, not omitted                             | "records the known minimatch advisory as FAIL"                                                    | PASS                      | same                             | local         | branch head |
| Gate records G1..G4 use OPS-03 logic, never GO                                          | "G1..G4 verdicts on the real tree are NO-GO or AWAITING_EVIDENCE, never GO"                       | PASS                      | `gates/G1.md` .. `gates/G4.md`   | local         | branch head |
| Optional capabilities DEFER with proof                                                  | "lists AGT-05 and AGT-06 as DEFER with guard tests"                                               | PASS (listed, not re-run) | `rollout-rollback.md`            | local         | branch head |
| Operator action index covers every AWAITING_OPERATOR line                               | "lists every AWAITING_OPERATOR line once and matches the committed file"                          | PASS                      | `operator-action-index.md`       | local         | branch head |
| Decisions O01..O08, D-01..D-12 linked to the FND-01 matrix                              | "decision status matches the FND-01 matrix"                                                       | PASS                      | `decisions-status.md`            | local         | branch head |
| Mandatory stage gates signed for exact digest/schema/config                             | none possible offline                                                                             | AWAITING_OPERATOR         | `go-no-go-form.md`               | live          | n/a         |
| Rollback compatibility tested on the combined revision                                  | per-task tests exist; combined rehearsal not run                                                  | AWAITING_OPERATOR         | `rollout-rollback.md`            | live          | n/a         |
| Operator approves rollout                                                               | none                                                                                              | AWAITING_OPERATOR         | `operator-action-index.md`       | live          | n/a         |

- Positive controls: a clean tree with passing security input and live-observed results builds a bundle with the label `live`; `verifyBundle` accepts an untouched bundle.
- Negative and fault cases: tampered evidence file, tampered bundle digest, missing or non-contiguous migration, invalid SHA or digest, offline provenance labeled live, live label with no live results, overwrite of an existing bundle, absent security output (BLOCKED), a failing run without the known advisory.
- Migration/backward compatibility: no migration added. Rollback and forward repair for 0024..0030 are in `rollout-rollback.md`, taken from each task's notes.
- Rollback or forward repair: delete the new files. The tools only read the repository.
- Open risks / decisions / follow-up owner: `residual-risk-register.md`. Notable: `pnpm lint:security` exits 1 with three findings (R-01, R-02), and six tasks have no `evidence.md` (R-04).
- Operator work still required: `operator-action-index.md`.
- Integration validation on combined revision: not run. Every gate verdict is NO-GO because of the security failures, with missing live evidence and approvals as further reasons.
- Postmortem: skipped by the worker; coordinator decides.

## Commands

- `pnpm exec vitest run --project scripts`: exit 0, 13 files, 284 passed, 2 skipped (not OPS-05).
- `pnpm exec eslint scripts/ops-05`: exit 0. `pnpm exec prettier --check` on the write set: exit 0. `pnpm knip`: exit 0 apart from one existing configuration hint.
- `pnpm build` and `pnpm typecheck`: not run. Only `.mjs` scripts and Markdown changed, and nothing under `apps/api/src`.
- Positive control sample bundle on `b322e7d` built by the CLI (digest recorded only in a scratch directory, not committed). A second run into the same directory was refused with `output-exists`.
- `pnpm lint:security` on `b322e7d`: exit 1 (3 issues). Raw output in `inputs/lint-security.json`.
- Regenerate: `node scripts/ops-05/render-index.mjs` then `node scripts/ops-05/render-gates.mjs docs/plans/enterprise-production-v1/ops-05/inputs/release-input.json docs/plans/enterprise-production-v1/ops-05/gates`.
- Build a bundle: `node scripts/ops-05/build-bundle.mjs docs/plans/enterprise-production-v1/ops-05/inputs/release-input.json <outDir>`. The operator supplies image digests and live results in the input; writing never overwrites.
- Gate inputs that need an operator: image digests, model binding, approvers, live results with live-observed provenance, and `runs` (per-file PASS/FAIL of the mapped invariant tests).
