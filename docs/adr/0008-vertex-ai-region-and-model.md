# 8. Vertex AI region and model

Date: 2026-11-25

## Status

Proposed

Partly supersedes [ADR 0003](0003-pilot-decisions.md): only its **Region** pin, and only for Vertex AI inference.

## Context

[ADR 0003](0003-pilot-decisions.md) pins the pilot to `asia-northeast1`. The local stack follows it: `compose.m1.yaml` and `compose.p0.yaml` default to `asia-northeast1` and `gemini-2.5-flash`. The docs say a global-only model needs a recorded residency exception under ADR 0003, and none exists. Yu does not need model calls to stay in `asia-northeast1`.

Google now documents Vertex AI as Gemini Enterprise Agent Platform. The host is still `aiplatform.googleapis.com`. As of 2026-11-26, its docs say:

- `gemini-2.5-flash` and `gemini-2.5-pro` were retired on 2026-10-20 ([lifecycle][lifecycle]).
- `gemini-4-hydrogen` has been GA since 2026-11-12, on `global`, `us` and `eu` only ([model][hydrogen], [release notes][release-notes]).
  - Price: $1.50 input and $7.50 output per 1M tokens ([pricing][pricing]).
  - Lifecycle: short-term. Google has announced no retirement date and gives at least 45 days' notice ([lifecycle][lifecycle]).
  - Thinking: `thinkingLevel` takes LOW, MEDIUM, HIGH (the default) or XHIGH, and `thinking_budget` returns 400.
- `gemini-3.8-flash` stays available until at least 2027-09-02 ([lifecycle][lifecycle]). It has been GA in `asia-northeast1` since 2026-11-09 ([release notes][release-notes]), but its model page lists Standard PayGo only for `global`, `us` and `eu` ([model][flash]).
- No Gemini 4 model offers ML processing in Japan. Requests to `global` may be processed in any Google Cloud location, with no data-residency guarantee ([data residency][residency]).
- These models have no `-00N` versions. The model ID is the version ([model][hydrogen], [model][flash]).

The [#108 probe](../spikes/agent-platform/model.md#live-evidence-2026-10-15-operator-probe) is dated evidence from 2026-10-15, before the retirement and the Tokyo GA. It got 200 for both 2.5 models on `asia-northeast1`. `gemini-3.8-flash` and `gemini-4-argon` returned 404 there and 200 on `global`. It did not probe Hydrogen.

The [2026-11-26 probe](../spikes/agent-platform/model.md#live-evidence-2026-11-26-operator-probe) came after both. On `global`, `gemini-4-hydrogen` and `gemini-3.8-flash` returned 200. Hydrogen accepted `thinkingLevel` in uppercase and lowercase, and `temperature: 0.2`. On `asia-northeast1`, `gemini-2.5-flash` still returned 200 despite its listed retirement, and `gemini-3.8-flash` still returned 404. So the probe did not confirm that `gemini-2.5-flash` is gone, which the Accept probe in Consequences asks for.

The P0 and M1 runs used `gemini-3.8-flash` on `global` (`docs/p0/PROGRESS.md`, `docs/m1/PROGRESS.md`).

## Decision

Vertex AI inference uses the `global` endpoint.

- **Default:** `gemini-4-hydrogen`. Every call sends `thinkingLevel` explicitly: HIGH unless the caller asks for LOW. HIGH is Hydrogen's default, and thinking tokens are billed as output ([pricing][pricing]). Pinning the level keeps cost from shifting if Google changes the default.
- **Fallback:** `gemini-3.8-flash`, under the same rule. It accepts LOW, MEDIUM and HIGH, and its own default is MEDIUM ([model][flash]).

`asia-northeast1` + `gemini-3.8-flash` is a possible future residency option. It is not allowed until a probe shows that it answers. Any other model (Argon, Neon, Carbon or later) or endpoint needs a new ADR.

## Consequences

- Every model call loses residency. Prompts and responses may be processed outside Japan.
- Hydrogen can be retired on 45 days' notice. `gemini-3.8-flash` is the fallback because it is committed until at least 2027-09-02. Check the [lifecycle page][lifecycle] before relying on either model.
- What the dev Terraform creates stays in `asia-northeast1`. That covers the provider region in `providers.tf`, the Workflows region in `workflows.tf`, the Cloud Run services, IAP, Artifact Registry and Secret Manager replicas, and the opt-in Cloud SQL, network, KMS, BigQuery and Cloud Scheduler modules. Each of these modules in `infra/terraform/modules/` validates `region == "asia-northeast1"`.
- Once accepted, this record is the "recorded residency exception" that the docs refer to.
- The full model ID is the pin. Runs must log the response `modelVersion` and compare it with that ID.
- `apps/api/src/model-routing/router.ts` denies `cross_region` when regions differ. It is not on the live Vertex path today. Whoever wires it in must allow `global`.
- Accept requires a fresh probe:
  - `gemini-4-hydrogen` on `global`;
  - `gemini-3.8-flash` on `global`;
  - `gemini-2.5-flash` on `asia-northeast1`, to confirm that it is gone.

  The same run can probe `gemini-3.8-flash` on `asia-northeast1` for the residency option.

- Follow-up code work, not made here:
  - the compose defaults, which point at the retired `gemini-2.5-flash`. They need fixing whatever happens to this record;
  - the model expectations in `e2e/m1/live/journeys.spec.ts`, `e2e/p0/real-llm/flagship.spec.ts`, `e2e/ui/journeys/steps.ts` and `scripts/ui/stack.mjs`;
  - `docs/ui/ui.env.example`;
  - the residency and model rows in `docs/m1/README.md`, `docs/p0/README.md`, `docs/ui/README.md` and `docs/ui/ARCHITECTURE.md`;
  - `apps/api/src/workbench/vertex.ts`. It must send `thinkingLevel` on every call (HIGH when a request sets none), because today a request without `thinking` sends none. Its `thinkingBudget` branch for Gemini 2.x can go.
- On Accept, link this record to ADR 0003 as an amendment (`adr link 8 Amends 3 "Amended by"`), the way ADR 0007 plans to. `create-adr.sh --proposes 3` would mark all of ADR 0003 Superseded.

[lifecycle]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
[hydrogen]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-hydrogen
[flash]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash
[pricing]: https://cloud.google.com/model-garden/pricing
[release-notes]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes
[residency]: https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency
