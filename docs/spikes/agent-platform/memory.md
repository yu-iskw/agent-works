# memory — offline probe for #107

Verdict: **UNVERIFIED / DEFER**. This is a synthetic offline harness. It does not
establish service availability, launch stage, IAM behavior or permission to deploy.
Live date, actual region support and maturity are **unverified**. The selected
pilot region is `asia-northeast1` under [ADR 0003](../../adr/0003-pilot-decisions.md).
The fabricated `2000-01-01` timestamp identifies fixtures, not a live observation.

## Evidence and scope

`../../../spikes/agent-platform/memory/probe.mjs` defines policy expectations.
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
| `cross-user-memory`         | Synthetic cross-user-memory control challenge.            |
| `cross-agent-memory`        | Synthetic cross-agent-memory control challenge.           |
| `revoked-read`              | Synthetic revoked-read control challenge.                 |
| `delete-request`            | Synthetic delete-request control challenge.               |
| `read-after-deletion`       | Synthetic read-after-deletion control challenge.          |
| `retention-expired`         | Synthetic retention-expired control challenge.            |
| `deletion-unsupported`      | Synthetic deletion-unsupported control challenge.         |
| `retention-unverified`      | Synthetic retention-unverified control challenge.         |
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
3. Use only non-sensitive test records with explicit user and agent ownership; memory remains disabled for the pilot.
4. Recheck source authority at retrieval, attempt user B and another agent access, then revoke user A access.
5. Request deletion and demonstrate subsequent retrieval denial; separately record derived memories, logs, backups and retention/TTL semantics.
6. If deletion or ACL semantics cannot be demonstrated, DEFER. Confirm processing and storage regions separately and do not infer service maturity.
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

Leave Memory Bank disabled under Phase 4; use short-lived authorized session context without personalization (RFC §§4.3, 9).

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

## Deletion and retention limits

`lifecycle.mjs` replays read/delete/read and expiry evidence with immutable
ownership. A delete acknowledgement alone cannot prove erasure; missing deletion
support, retrieval denial or retention evidence requires DEFER. Backup/log/derived
representation erasure stays unverified until separately demonstrated. No record
is persisted and Phase 4 adoption remains deferred regardless of replay results.
