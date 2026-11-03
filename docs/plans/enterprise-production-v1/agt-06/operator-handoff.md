# AGT-06 operator handoff (AWAITING_OPERATOR)

Uses the concrete-action shape of `templates/operator-approval.md`. This file is not an approval. The agent prepared it. The operator approves and runs the live probes.

- Task and reason: AGT-06. Fill the UNKNOWN cells in [comparison.md](comparison.md) with live evidence from #105 and #107 so a GO or NO-GO can replace DEFER.
- Exact project/environment/region: isolated sandbox project, pilot region `asia-northeast1` (ADR 0003). Actual service availability there is UNKNOWN.
- Source SHA / image digest / versions: harness repo SHA, tested SDK and API versions, and the image digest a gate record would bind to.
- Proposed workflow: follow `docs/spikes/agent-platform/memory.md` and `runtime.md` operator runbooks. Use only non-sensitive test records with pseudonymous users A and B and two agents.
- Required observations:
  1. User A memory unavailable to user B; other agent denied; revoked access denied.
  2. Deletion request, then recall denial. Separately record derived memories, logs, backups and retention.
  3. Storage region and model-processing region, recorded as two values.
  4. Session isolation, restart recovery, quotas, pricing source, launch stage, tested API versions.
  5. Core task recovery with the adapter disabled in the deployed environment.
- IAM scopes or external writes: only what the sandbox project needs. No enterprise personal data, no production credentials.
- Expected cost and blast radius: UNKNOWN. Operator sets a spend limit.
- Preconditions and local evidence: `pnpm exec vitest run --project @agent-works/api apps/api/src/capabilities` passes.
- Stop conditions: any cross-user read, deletion not demonstrable, or a region other than the approved one. Record NO-GO or DEFER.
- Rollback or recovery: delete test records and sandbox resources. Capability stays disabled without a GO record.
- Evidence to capture: sanitized #98 envelopes per the probe runbooks plus dated pricing and quota references. No secrets or raw prompts.
- Requested approval scope and expiry: operator fills in.
- Approver / approval reference / timestamp: operator fills in.

If deletion or ACL semantics cannot be demonstrated, the verdict is DEFER. Record it in [gate-decision-record.md](gate-decision-record.md). Missing fields block execution.
