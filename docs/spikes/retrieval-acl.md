# Retrieval ACL comparison (#22)

Date: 2026-10-13. Outcome: **DEFER**. Arm A (Gemini Enterprise) is DEFER/unavailable; arm B (caller-delegated Drive) is UNVERIFIED. There is no live evidence for either arm. The comparison report leaves recall, absolute/relative latency, revocation lag, deletion lag and cost null. Issues #23/#24 remain blocked by this recorded retrieval gate. This report does not change the actual GitHub issue state.

The bundle implements an offline evaluator and caller-delegated adapter. It does not create a custom index, integrate route selection, provision identities or infrastructure, or claim authorization isolation in the live pilot.

## Fixed corpus and matrix

`spikes/retrieval/compare/matrix.ts` is the single corpus/matrix definition used by both harnesses. The common query is `bundle-b-corpus`. Every document must contain that phrase and three distinct surface canaries. The public document is intentionally readable by everyone. The aliases are synthetic; private operator maps bind them to real source objects and verified subjects.

| Case            | Subject                             | Expected relevant objects              | Forbidden objects                     |
| --------------- | ----------------------------------- | -------------------------------------- | ------------------------------------- |
| Alice           | alice                               | alice-private, reviewer-shared, public | bob-private                           |
| Bob             | bob                                 | bob-private, public                    | alice-private, reviewer-shared        |
| Shared group    | reviewer                            | reviewer-shared, public                | alice-private, bob-private            |
| Outsider        | outsider                            | public                                 | both private objects, reviewer-shared |
| Revoked member  | reviewer after source group removal | public                                 | both private objects, reviewer-shared |
| Source deletion | alice after alice-private deletion  | reviewer-shared, public                | deleted alice-private, bob-private    |

Title, snippet and content are checked separately, including cross-document contamination. Raw sanitized response text preserves answer/error/extra fields. Returned object identifiers and source URIs can reveal existence and are also checked. Unknown objects or absent/mismatched/unverified source provenance fail closed. Object provenance must contain source URI, version, retrieval timestamp, subject-bound access reference and an explicit source access recheck. Source URI must match the object ID. Canary scanning is a fixed-corpus test, not a general detector for every possible paraphrase; source ACL and provenance review are still required.

## Evidence contract

`compare/schema.ts` defines strict Zod schemas for hits, cases, evidence and envelopes. It validates fixed query/identity binding, duplicates, capture order, service/arm binding, finite measurements, missing values and synthetic/observed provenance. Synthetic evidence cannot be GO or carry live measurements. Observed evidence needs a valid sealed C-04 transcript under #98, with matching provenance, capture time, region, verdict and one `evidence-sha256` observation binding the full payload. Evidence has its own canonical SHA-256 digest too. A checksum establishes deterministic integrity, not independent cloud authenticity; the operator must review source capture and identity mappings.

The synthetic report date describes local preparation. Region describes the intended pilot configuration. The adapter's global Drive endpoint is not a residency measurement, and the managed-search trial is unavailable. Recorded response fixtures are explicitly synthetic service-shaped recordings, not downloaded cloud transcripts. The in-memory tests exercise the observed-evidence branch with test-only inputs; none is saved as a live PASS.

Revocation/deletion measurements require timestamped targeted checks and at least two consecutive denials. The reported lag is the first stable denied sample minus authoritative change time: a sampled upper bound. Polling intervals and all stale allows must be retained by the operator. An allow in the post-change checks is a disclosure and disqualifies the arm even if subsequent checks deny. A failed request, lost identity or empty unrelated query is unavailable evidence, never successful revocation. `drive/revocation.ts` implements bounded operator polling and `compare/revocation.ts` implements deterministic summarization.

## Proposed thresholds for owner review

These numbers are proposals, not measured results or accepted SLOs. `status: proposed` and `approvedBy: null` prevent a selection even if otherwise complete observed evidence is supplied.

| Metric                  | Proposed gate                                                   | Measurement                                                                                  |
| ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Access isolation        | Zero cross-user/title/snippet/content/existence disclosures     | Currently unverified                                                                         |
| Provenance              | Every hit has matching source/object/version/access binding     | Currently unverified                                                                         |
| Recall                  | At least 0.90                                                   | Distinct expected relevant IDs retrieved / total expected relevant IDs, across the six cases |
| Absolute latency        | p95 at most 5,000 ms                                            | Nearest-rank p95 of complete end-to-end case timings; missing timings defer                  |
| Revocation and deletion | Stable sampled denial within 60,000 ms; no disclosure permitted | Both change cases measured independently, with retained samples                              |
| Relative latency        | Report B p95 / A p95                                            | Null unless both are measured and A p95 is positive                                          |
| Cost                    | Record observed USD and feature scope                           | No invented cost ceiling; ADR-0003 tracks spend without a cap                                |

The owner must review these proposals using real pilot evidence, especially the revocation budget. A 60-second threshold does not excuse a cross-user leak. Six cases are the minimum correctness matrix, not a statistically useful performance benchmark; operator repetitions are needed for a production latency/recall decision. This schema captures one case observation per case per run; preserve repetitions as separately named runs.

## Outcome rules

A recorded disclosure, unknown source, invalid provenance, explicit NO-GO or approved revocation/deletion budget failure disqualifies that arm. Incomplete, unavailable, unverified or unsigned-threshold evidence defers. A complete safe arm below approved recall/latency thresholds is `neither`. RFC-001 prefers arm A if both qualify. ADR-0003 permits B when A defers and B independently qualifies. Two disqualified arms produce NO-GO; two measured safe but insufficient-quality arms produce neither; an unresolved arm leaves DEFER when no arm qualifies. Selection of A or B alone clears the report's downstream block list.

## Replay and verification

From the repository root:

```sh
node spikes/retrieval/compare/run.ts docs/spikes/retrieval/managed.json docs/spikes/retrieval/drive.json
node --test spikes/retrieval/drive/replay.test.mjs spikes/retrieval/managed/replay.test.mjs spikes/retrieval/compare/evaluate.test.mjs
pnpm test apps/api/src/retrieval/drive-adapter.test.ts
pnpm exec tsc --noEmit -p apps/api/tsconfig.json
pnpm exec tsc --noEmit -p spikes/retrieval/compare/tsconfig.json
pnpm exec eslint apps/api/src/retrieval/drive-adapter.ts apps/api/src/retrieval/drive-adapter.test.ts
pnpm exec eslint --config spikes/retrieval/compare/eslint.config.mjs 'spikes/retrieval/**/*.ts'
node spikes/common/verify.mjs
```

The comparison CLI reads files and emits deterministic JSON. It does not write reports or call a cloud service. An optional third path supplies a strict threshold object with explicit approval. Without it, proposals always apply. The saved `retrieval-acl.json` is its output for the two saved arm reports. The API test's Node bridge includes every spike suite in the existing Vitest `pnpm test` gate. No shared configuration or CI file is edited. Trunk is intentionally skipped for this bundle.

## Handoff and session learning

Implementations, negative fixtures, sealed deferred reports and tests are ready for review. Live source/identity evidence and owner threshold approval remain the gates. This session found that newer Node versions choose a different test reporter; the discovered Vitest bridge now explicitly selects TAP instead of relying on a default. It also made polling proof mandatory instead of accepting a claimed revocation number alone. These fixes live in the allowed harness paths; no shared agent-rule or CI change is needed. See the arm reports for operator steps and exact feature limits.

## Local validation result

The workspace build and API/spike TypeScript checks passed. The three retrieval Vitest files passed 84 tests, including the Node bridge; the standalone spike suites passed their negative ACL and integrity cases. The unchanged #98 verifier passed both C-04 transcripts and its own 21 tests. Targeted ESLint checks run without Trunk; filesystem-path warnings refer to local fixture reads and explicitly supplied CLI evidence paths.

An additional full `pnpm test` run finished with 65 passing files, nine Postgres-dependent suites failing database startup hooks, and the existing ADK p95-ratio test failing (10 failed files total; 580 passed tests, one failed, 66 skipped). Those files were not changed. Bundle B's offline tests remain green. The validated local runtime was Node 26.11.1; CI's pinned Node 24.13.0 was not installed or changed in this worktree.
