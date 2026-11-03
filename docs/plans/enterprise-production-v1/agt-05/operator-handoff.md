# AGT-05 operator handoff (AWAITING_OPERATOR)

Uses the concrete-action shape of `templates/operator-approval.md`. This file is not an approval. The agent prepared it. The operator approves and runs the live probe.

- Task and reason: AGT-05. Obtain live evidence that a managed or isolated sandbox meets the negative matrix, so a GO gate record can be considered. Without it the capability stays disabled.
- Exact project/environment/region: operator names an isolated sandbox project. Pilot region is `asia-northeast1` (ADR 0003). Region support is UNKNOWN until observed.
- Source SHA / image digest / config versions: record the repo SHA of the harness and the deployed image digest the gate record will bind to.
- Proposed commands: run the #111 operator runbook in `docs/spikes/agent-platform/sandbox.md`. For each of the six matrix case ids in [README.md](README.md), run one fixed reviewed hostile payload. Do not run untrusted code from a Cursor agent.
- IAM scopes or external writes: only what the sandbox project needs. No production data, no user credentials. State the exact roles when approving.
- Expected cost and blast radius: UNKNOWN. Operator sets a spend limit for the probe project.
- Preconditions and local evidence: `pnpm exec vitest run --project @agent-works/api apps/api/src/capabilities` passes on the harness revision.
- Stop conditions: any case shows `breached`, credentials appear in output, or egress to an unlisted host succeeds. Stop and record NO-GO.
- Rollback or recovery: delete the probe project resources. The capability remains disabled because no GO record exists.
- Evidence to capture: product and API name, launch stage, region, quota and pricing source, measured behavior per case. Seal it with `sealSandboxEvidence` (fields: `probe`, `issue`, `source: operator-live`, `capturedAt`, `region`, `product`, `launchStage`, `cases`). Strip secrets and raw payloads first.
- Ingest: pass the sealed object to `assessSandboxEvidence`. Expect `PASS / GO-ELIGIBLE` only if all six cases are `held` in `asia-northeast1`.
- Requested approval scope and expiry: operator fills in.
- Approver / approval reference / timestamp: operator fills in.

After a PASS, record the decision in [gate-decision-record.md](gate-decision-record.md). Missing fields block execution.
