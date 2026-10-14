# Model outage: bounded retries and explicit degradation

## Authority

This offline procedure covers RFC-001 §15.3 and §19.1. Retry caps, deadlines, backoff
values, prices, SLO targets and retention are **UNAPPROVED PLACEHOLDERS**.
**Deletion, dev hard stops and real restores are not authorized** under D-08, D-10
and [ADR 0003](../adr/0003-pilot-decisions.md). This runbook grants no model,
inference-region, token, spend, production traffic or automated notification approval.

## Identify

Inspect protected telemetry for dependency, trace/task identity, retries, outcome and
latency. Do not log provider exception bodies, tokens, request prompts or retrieved
content. Unknown errors fail closed as permanent; an adapter must explicitly classify
transient unavailability or rate limits. Policy and permanent errors are never retried.

## Bound the outage

Opted-in adapters share a finite retry pool across the affected outage domain. Each
invocation also has a maximum attempt count, absolute deadline, minimum remaining
attempt time and jittered capped exponential backoff. A pool is not replenished on
client restart or each retry. In-flight transport cancellation remains the adapter's
responsibility: the wrapper cannot undo a side effect or terminate an arbitrary
provider promise. Never apply generic retries to a risky write without independent
idempotency and receipt recovery.

When the budget or deadline is exhausted, surface a controlled unavailable result
and preserve evidence. Do not silently pick another provider or extend the deadline.
Record affected high-cost skill/model versions for the separate L5 control owner.
This bundle does not implement suspension or a kill switch.

## Degrade explicitly

| Dependency   | Safe behavior                                                           |
| ------------ | ----------------------------------------------------------------------- |
| Model        | Use an explicitly approved fallback only; otherwise return unavailable. |
| Search       | Explain that grounding is unavailable; do not invent source support.    |
| Write broker | Deny the write and preserve its receipt/review evidence.                |
| Memory       | Continue without personalization only when safe for that task.          |

The pure degradation module returns the permitted response. It does not authorize
an alternate model family, fetch credentials, invoke a write or change routing.

## Recovery evidence

Run the taxonomy and storm property tests and inspect the fixture SLO report. Check
that recovery has not minted new task IDs, retried policy errors, lost receipt
correlation, duplicated external effects or revealed raw prompt/token canaries.
Keep service requirements and actual targets open under D-10. Do not treat a passing
fixture latency report as a provider guarantee or a production availability promise.
