# model — offline probe for #108

Verdict: **UNVERIFIED / DEFER**. This is a synthetic offline harness. It does not
establish service availability, launch stage, IAM behavior or permission to deploy.
A bounded operator probe on 2026-10-15 observed which models answer on which
endpoint (see [Live evidence](#live-evidence-2026-10-15-operator-probe)). Launch
stage, processing region and IAM stay **unverified**. The selected pilot region
is `asia-northeast1` under [ADR 0003](../../adr/0003-pilot-decisions.md). The
fabricated `2000-01-01` timestamp identifies fixtures, not a live observation.

## Evidence and scope

`../../../spikes/agent-platform/model/probe.mjs` defines policy expectations.
`evidence.mjs` imports the #98 schema/sealer/verifier unchanged, then checks exact
probe binding, scalar field names/types, duplicate fields, privacy and outcomes.
The checksum detects accidental alteration; it is not a signature or proof of
truth. Resealing fabricated evidence cannot turn it into live validation.

The injected backend exposes `exchange(caseId, request)` and returns sanitized
scalar observations. `recordedBackend` validates a sealed recording before replay
and matches its request exactly. No cloud SDK, network connection, environment
credential, resource creation or actual enterprise data is used. This is an
adapter contract for observations, not an emulator of an undocumented provider API.

All scenario labels, users, agents and thresholds are **synthetic**. Negative
control scenarios can be correctly denied and still have an UNVERIFIED adoption
verdict. `successful-control-bypass` deliberately records unauthorized success
and must yield **NO-GO**. A malformed transcript is rejected, rather than treated
as trustworthy evidence of either success or failure.

| Synthetic case              | Challenge                                                 |
| --------------------------- | --------------------------------------------------------- |
| `bounded-read`              | Synthetic authorized read; no cloud behavior is asserted. |
| `disallowed-region`         | Synthetic disallowed-region control challenge.            |
| `disallowed-model`          | Synthetic disallowed-model control challenge.             |
| `global-endpoint`           | Synthetic global-endpoint control challenge.              |
| `endpoint-failure`          | Synthetic endpoint-failure control challenge.             |
| `prompt-not-redacted`       | Synthetic prompt-not-redacted control challenge.          |
| `revoked-user`              | Synthetic revoked-user control challenge.                 |
| `write-request`             | Synthetic write-request control challenge.                |
| `successful-control-bypass` | Synthetic unauthorized success; must produce NO-GO.       |

## Offline operation

From the repository root, with existing dependencies installed:

```sh
node --test spikes/agent-platform spikes/common
node spikes/agent-platform/run.mjs
```

Inspect `fixtures/valid.json` for a sealed baseline, `scenarios.json` for explicit
negative backend responses and `negative.json` for invalid evidence recipes.
Tests also inject malformed JSON, resealed semantic changes, secrets, escaped
emails, unmarked redaction, observed GO, wrong request bindings and duplicate
recordings. Logs contain safe reason codes, never evidence payloads.

## Operator runbook (future live evidence)

1. Obtain an approved isolated GCP sandbox, test identities and IAM authorization
   under #19. An operator performs live actions outside this offline harness.
2. Identify the exact product, SDK/version and API operations. Capture dated
   documentation references for actual Tokyo availability, observed maturity,
   quota and pricing. Record unsupported operations explicitly.
3. Bind the exact approved model/version and regional endpoint; synthetic-model-v1 is a fixture label, never a deployable model.
4. Verify inference processing location independently from endpoint hostname; reject disallowed models/regions and global fallback.
5. Force endpoint failure and confirm no policy bypass; redact sensitive prompt and tokens before writing evidence.
6. Record tested request API, quota and pricing source, latency samples and measured cost where available. Do not invent numerical estimates.
7. Strip credentials, user identifiers, emails, raw prompts and raw outputs before
   creating #98 envelopes. Use non-sensitive pseudonyms and complete redaction
   markers. Preserve sanitized measured observations, source references and
   omissions in a separate operator evidence review; the offline scalar contract
   deliberately does not accept arbitrary text or API payloads.
8. Replay sanitized recordings offline and obtain human review. An `observed`
   provenance flag is self-reported, not proof. This bundle cannot produce GO.
   If evidence is unavailable, incomplete or region support is missing, DEFER;
   demonstrated control failures are NO-GO. Update only this probe's verdict
   after an authorized live evidence review, never the #20 summary here.

## Live evidence (2026-10-15 operator probe)

Source: the [operator comment on #108](https://github.com/yu-iskw/agent-works/issues/108#issuecomment-6187325519).
An operator ran one short synthetic prompt per call in a sandbox project, with no
enterprise data. Identities, project identifiers, prompt text and model outputs
are left out.

| Endpoint          | Model              | Result (n) | Latency (ms, observed) |
| ----------------- | ------------------ | ---------- | ---------------------- |
| `asia-northeast1` | `gemini-2.5-flash` | 200 ×3     | 586–717                |
| `asia-northeast1` | `gemini-2.5-pro`   | 200 ×1     | 1325                   |
| `asia-northeast1` | `gemini-3.8-flash` | 404 ×5     | —                      |
| `asia-northeast1` | `gemini-4-argon`   | 404 ×1     | —                      |
| `global`          | `gemini-3.8-flash` | 200 ×3     | 1148–1662              |
| `global`          | `gemini-4-argon`   | 200 ×1     | 2290                   |

Latency values are small-n observations, not percentiles.
A 200 shows that the endpoint served the model, not where inference ran.

`gemini-3.8-flash` and `gemini-4-argon` are **not available in `asia-northeast1`;
global-only; residency exception required** (ADR 0003 pins `asia-northeast1`).

| Live evidence field          | Current value                                   |
| ---------------------------- | ----------------------------------------------- |
| Observation date             | 2026-10-15                                      |
| Product and API              | Vertex AI `generateContent`, publisher `google` |
| API version                  | unverified                                      |
| Model versions               | aliases, not pinned versions                    |
| Processing/storage region    | unverified                                      |
| Service maturity             | unverified                                      |
| Quota and pricing references | unverified                                      |
| Cost                         | unverified                                      |
| IAM/control behavior         | unverified (`aw-api` runtime IAM not exercised) |

The P0 discovery `GET` in [ACCEPTANCE_REPORT.md](../../p0/ACCEPTANCE_REPORT.md)
reported launch stage GA for `gemini-3.8-flash` on `global` only. This probe did
not establish launch stage for any model.

## Fallback

Pending the unverified rows above, the pilot fallback is `gemini-2.5-flash` or
`gemini-2.5-pro` on the `asia-northeast1` regional endpoint. The policy layer
must deny every other model, region and the global endpoint (RFC §6.4, §13.4).
The service does not do this on its own: the global endpoint served both models
that return 404 on `asia-northeast1`. The compose defaults now use the regional
2.5 pair (`asia-northeast1` + `gemini-2.5-flash`).

The JSON verdict is an offline review artifact, not a #98 transcript. Synthetic
results must not populate live measurement fields or imply GA. No production
integration, dispatch port, route, ledger adapter or worker is changed.
