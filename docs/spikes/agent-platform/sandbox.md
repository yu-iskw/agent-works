# sandbox — offline probe for #111

Verdict: **UNVERIFIED / DEFER**. This is a synthetic offline harness. It does not
establish service availability, launch stage, IAM behavior or permission to deploy.
Live date, actual region support and maturity are **unverified**. The selected
pilot region is `asia-northeast1` under [ADR 0003](../../adr/0003-pilot-decisions.md).
The fabricated `2000-01-01` timestamp identifies fixtures, not a live observation.

## Evidence and scope

`../../../spikes/agent-platform/sandbox/probe.mjs` defines policy expectations.
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
| `network-exfiltration`      | Synthetic network-exfiltration control challenge.         |
| `ambient-credentials`       | Synthetic ambient-credentials control challenge.          |
| `restricted-filesystem`     | Synthetic restricted-filesystem control challenge.        |
| `time-limit`                | Synthetic time-limit control challenge.                   |
| `memory-limit`              | Synthetic memory-limit control challenge.                 |
| `cpu-limit`                 | Synthetic cpu-limit control challenge.                    |
| `storage-limit`             | Synthetic storage-limit control challenge.                |
| `failed-isolation`          | Synthetic failed-isolation control challenge.             |
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
3. Identify the exact managed sandbox product/API, stage, region and quota; no untrusted program is executed by this harness.
4. In an approved operator sandbox, attempt network exfiltration and metadata/ambient credential access using non-sensitive canaries.
5. Attempt restricted filesystem access and cross-sandbox access; confirm isolated scratch space and scan approved outputs.
6. Measure process termination for time, CPU, memory and storage bounds; fixture thresholds are synthetic test policy, not vendor limits.
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

## Fallback and remaining evidence

Disable code execution until isolation is proved; use reviewed bounded application operations, or evaluate isolated Cloud Run/GKE execution per RFC §§4.3, 6.5.

| Live evidence field          | Current value |
| ---------------------------- | ------------- |
| Observation date             | unverified    |
| Product and API versions     | unverified    |
| Actual region availability   | unverified    |
| Processing/storage region    | unverified    |
| Service maturity             | unverified    |
| Quota and pricing references | unverified    |
| Measured latency and cost    | unverified    |
| IAM/control behavior         | unverified    |

The JSON verdict is an offline review artifact, not a #98 transcript. Synthetic
results must not populate live measurement fields or imply GA. No production
integration, dispatch port, route, ledger adapter or worker is changed.
