# runtime — offline probe for #105

Verdict: **UNVERIFIED / DEFER**. This is a synthetic offline harness. It does not
establish service availability, launch stage, IAM behavior or permission to deploy.
Live date, actual region support and maturity are **unverified**. The selected
pilot region is `asia-northeast1` under [ADR 0003](../../adr/0003-pilot-decisions.md).
The fabricated `2000-01-01` timestamp identifies fixtures, not a live observation.

## Evidence and scope

`../../../spikes/agent-platform/runtime/probe.mjs` defines policy expectations.
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

| Synthetic case               | Challenge                                                 |
| ---------------------------- | --------------------------------------------------------- |
| `bounded-read`               | Synthetic authorized read; no cloud behavior is asserted. |
| `cross-user-session`         | Synthetic cross-user-session control challenge.           |
| `cross-agent-session`        | Synthetic cross-agent-session control challenge.          |
| `bounded-abort`              | Synthetic bounded-abort control challenge.                |
| `restart-recovery`           | Synthetic restart-recovery control challenge.             |
| `restart-without-checkpoint` | Synthetic restart-without-checkpoint control challenge.   |
| `region-unavailable`         | Synthetic region-unavailable control challenge.           |
| `sdk-incompatible`           | Synthetic sdk-incompatible control challenge.             |
| `quota-exhausted`            | Synthetic quota-exhausted control challenge.              |
| `successful-control-bypass`  | Synthetic unauthorized success; must produce NO-GO.       |

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
3. Use a bounded read-only ADK-TS agent; record exact SDK/version and tested session/runtime APIs and unsupported operations.
4. Create a session as user A; attempt user B and another agent access, then abort and restart from a scoped checkpoint.
5. Measure warm first-token samples and p95 using a declared warm-up and sample definition; retain only sanitized timing evidence.
6. Record quota and price sources and actual selected-region availability; leave latency and cost unverified until measured.
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

Run the bounded ADK TypeScript read-only agent on Cloud Run with application session ownership checks and durable task state (RFC §4.3).

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

## Timing and recovery limits

`timing.mjs` computes p95 only from explicitly synthetic, finite samples; those
results never populate the live verdict. Recovery is a recorded state transition
with the same user/agent ownership. It does not prove durable vendor recovery.
The live operator must measure restart checkpoints, lost work, warm-up, sample
count, first-token boundaries and quota responses with the exact SDK/API.
