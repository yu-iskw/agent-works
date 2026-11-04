# ACL-01 operator handoff (live retrieval arms)

Status: AWAITING_OPERATOR. Nothing here has been run live. This is a request, not an approval.

- Task and reason: SEC-02 source ACL through retrieval. Run the fixed six-case matrix (`bundle-b-acl-v1`) against real Drive (arm B) and, if a trial exists, Gemini Enterprise (arm A), then aggregate.
- Environment: pilot project, region `asia-northeast1`, synthetic corpus only (never customer documents). Four verified identities: alice, bob, reviewer (group member), outsider. Revocation needs one real group removal and one real source deletion.
- Revision: the ACL-01 result SHA, with `pnpm build` output from that SHA.
- Scopes: arm B uses the existing delegated `drive.readonly` grant per caller. No service-account or domain-wide delegation. No external writes except the pre-agreed corpus changes (group removal, deleting `alice-private`).
- Cost and blast radius: a handful of read calls per case; arm A cost is the trial feature scope and must be recorded in `costUsd`.
- Stop conditions: any live disclosure to a wrong identity, any unmapped object, any token in captured output. Stop, keep the sanitized evidence, and report NO-GO.
- Rollback: restore the group membership and recreate the corpus object from the private operator map.
- Approval scope and expiry: to be filled by the approver (approver, reference, timestamp, expiry).

## Commands

1. Build and replay offline first (no cloud calls).

```sh
pnpm build
node spikes/retrieval/compare/local-harness.mjs
```

2. Arm B (Drive). Follow `docs/spikes/retrieval/drive.md` "Operator live runs": for each of the six cases run, with your private module,

```sh
node spikes/retrieval/drive/probe.mjs --operator-module /absolute/private/probe-config.ts
```

Add polling proof for `revoked-member` and `source-deletion` with `spikes/retrieval/drive/revocation.mjs`, keeping every sample (stale allows count as leaks). Normalize the six cases, set `provenance: observed`, `availability: available`, real `configuration` values and `featureStage` (never `offline-local-harness`), then seal with `bindEvidence` from `spikes/retrieval/compare/fixture-tools.mjs`. Observed seals get a unique transcript id `c04.drive.observed-<digest12>` and `live-probed: true`. Save as `docs/spikes/retrieval/drive.json`.

3. Arm A (managed search). Follow `docs/spikes/retrieval/managed.md`. With no trial, keep the committed DEFER/unavailable report; do not mock it. Otherwise seal observed evidence the same way and save as `docs/spikes/retrieval/managed.json`.

4. Verify the transcripts and aggregate. Omit a flag for an arm you could not test; it is reported UNTESTED.

```sh
node spikes/common/verify.mjs
node spikes/retrieval/compare/aggregate.mjs --managed docs/spikes/retrieval/managed.json --drive docs/spikes/retrieval/drive.json
```

Add `--thresholds approved.json` only after the owner approves the proposed numbers (`status: approved`, `approvedBy` set). Without it the aggregator can never select an arm.

## Reading the verdict

- `NO-GO`: any title, snippet, content, identifier or provenance leak, or a stale allow after revocation. Never selectable.
- `DEFER`: any arm untested, unavailable or unsigned thresholds. `UNTESTED` is not a pass.
- `A` or `B`: complete observed evidence, positive controls met, thresholds approved.
- `neither`: safe but a positive control, recall or latency gate failed.
- Exit code 1 with `offline-labeled-live`: an offline fixture was relabeled as live. Capture again.

## Evidence to capture

Sanitized `managed.json` and `drive.json`, the aggregator JSON output (records `revocationLagMs` and `deletionLagMs` per arm), the private alias map kept outside the repository, and the approval reference. Record the live result in `evidence.md` as live; the local rows stay local.
