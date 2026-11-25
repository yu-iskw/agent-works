# 8. Vertex AI region and model

Date: 2026-11-25

## Status

Proposed

Partly supersedes [ADR 0003](0003-pilot-decisions.md): only its **Region** pin, and only for Vertex AI inference.

## Context

[ADR 0003](0003-pilot-decisions.md) says the pilot runs in `asia-northeast1` and that the provider region in `infra/terraform/environments/dev/providers.tf` carries this answer. The local stack follows it. `compose.m1.yaml` and `compose.p0.yaml` default `GOOGLE_CLOUD_LOCATION` to `asia-northeast1` and `VERTEX_MODEL_ID` to `gemini-2.5-flash`. The docs say a global-only model needs a recorded residency exception under ADR 0003. No such record exists.

The [#108 operator probe](../spikes/agent-platform/model.md#live-evidence-2026-10-15-operator-probe) results:

- On `asia-northeast1`, `gemini-2.5-flash` and `gemini-2.5-pro` returned 200, and `gemini-3.8-flash` and `gemini-4-argon` returned 404.
- On `global`, `gemini-3.8-flash` and `gemini-4-argon` returned 200.

A 200 shows only that the endpoint served the model, not where inference ran. The processing and storage region is unverified for every endpoint, and so are maturity, quota, pricing and IAM. The probe used model aliases, not pinned versions.

The earlier sandbox milestones ran `gemini-3.8-flash` on `global` (`docs/p0/PROGRESS.md`, `docs/m1/PROGRESS.md`). `apps/api/src/workbench/vertex.ts` already builds the `global` host and sends `thinkingLevel` to models outside Gemini 2.x.

Yu does not need the pilot to stay on `asia-northeast1` for model calls.

## Decision

For Vertex AI inference, the pilot may use exactly two endpoints:

- `asia-northeast1`, with `gemini-2.5-flash` or `gemini-2.5-pro`, as the [Fallback in model.md](../spikes/agent-platform/model.md#fallback) allows today;
- `global`, with `gemini-3.8-flash` only.

Any other model or endpoint needs a new record. Every other part of ADR 0003 stays Accepted, including the region of everything the dev Terraform deploys.

Yu picks the default. On Accept, keep only the chosen option here:

- **(A, recommended)** Default to `global` + `gemini-3.8-flash`. The P0 and M1 sandbox runs used this pair.
- **(B)** Keep the default at `asia-northeast1` + `gemini-2.5-flash`. The `global` pair is reachable only through the `AW_M1_*` / `AW_P0_*` overrides.

A is recommended because the newer models answered only on `global` in the #108 probe, and the milestone records already show the pilot working on that pair. The probe has no same-model comparison across endpoints, so it does not show what `global` itself costs in latency.

## Consequences

- A call to `global` sends prompts and responses to `aiplatform.googleapis.com` rather than a regional host. Those calls lose the regional endpoint pin they have today. Under A that covers every call, and under B only override calls.
- What the dev Terraform creates stays in `asia-northeast1`. That covers the provider region in `providers.tf`, the Workflows region in `workflows.tf`, the Cloud Run services, IAP, Artifact Registry and Secret Manager replicas, and the opt-in Cloud SQL, network, KMS, BigQuery and Cloud Scheduler modules. Each of these modules in `infra/terraform/modules/` validates `region == "asia-northeast1"`.
- Once accepted, this record is the "recorded residency exception" that the docs refer to.
- `gemini-3.8-flash` is an alias. Step 3 of the model.md runbook asks for an exact model version, so Yu decides at Accept whether the alias is enough.
- `apps/api/src/model-routing/router.ts` denies `cross_region` when the requested model's region differs from the context's. Today only the memory port and the port contract import it, not the live Vertex path. Whoever wires it to live inference must allow the `global` pair.
- Follow-up, not made here. Under either option:
  - `docs/spikes/agent-platform/model.md` (Fallback, runbook steps 3 and 4) and `model.json` (`fallback`, `globalOnlyModels.status`) stop requiring a regional endpoint and denial of the global one;
  - `docs/m1/README.md`, `docs/p0/README.md`, `docs/ui/README.md`, `docs/ui/ARCHITECTURE.md` and `docs/ui/ui.env.example` link to this record instead of a "recorded residency exception". Under A, the same edit also updates their `asia-northeast1` + `gemini-2.5-flash` rows and values.
- Follow-up under A only: `compose.m1.yaml` and `compose.p0.yaml` default to `global` and `gemini-3.8-flash`. The live expectations follow, in `scripts/ui/stack.mjs` (`modelId`), `e2e/m1/live/journeys.spec.ts` (`startsWith('gemini-2.5-flash')`), `e2e/ui/journeys/steps.ts` (`/^gemini-2\.5-flash/`) and the `P0_EXPECTED_MODEL` default in `e2e/p0/real-llm/flagship.spec.ts`. `vertex.ts` needs no change.
- On Accept, link this record to ADR 0003 as an amendment (`adr link 8 Amends 3 "Amended by"`), the way ADR 0007 plans to. `create-adr.sh --proposes 3` would mark all of ADR 0003 Superseded.
