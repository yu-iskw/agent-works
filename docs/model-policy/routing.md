# Approved model routing

An approved entry pins `modelId`, `version`, `region`, `governanceZone`, a known `costClass` and an approval reference. Identity keys include all four model/geography/governance coordinates. Duplicate allowlist identities and duplicate task-class rules are rejected at policy parsing.

`createModelRouter` receives policy, benchmark and evidence ports. The single default model is selected when a task class has no rule or its attached benchmark fails validation. Disabled rules create `benchmark_disabled` audit evidence. A model outside the allowlist, or outside the inference context's region/governance zone, is denied before model transport.

Enabled rules select their target and ordered fallback chain. Every member is authorized before the first call; a forbidden fallback invalidates the chain, even if the first model might have succeeded. Fallbacks must keep both region and governance zone unchanged. Only `RetryableModelFailure` advances the chain; validation, policy, persistence and suspension failures do not.

## Benchmark evidence

Artifacts extend the existing #136 scorer output with dataset fingerprints and `routingEvidence` containing the exact candidate model identity and task class. The comparison requires matching datasets and case identities, valid metric numerators/denominators, no leaks or unauthorized executions, and non-inferior metrics overall, by ACL group and for every case. Missing, malformed, mismatched or inferior evidence keeps the rule disabled.

File-backed artifacts are read only from the configured trusted directory. JSON attachments cannot traverse out of it; missing files fail closed. Memory-backed fixtures are cloned on construction. Neither model output nor a supplied `passed: true` can enable a rule.

`pnpm --filter @agent-works/api-contract eval:benchmarks` derives example baseline/candidate attachments from existing harness fixtures. The observations are identical: they demonstrate contract plumbing and cannot establish real model quality, speed or cost.

## Execution evidence and hooks

Before execution, the router persists an inference row with task/trace, full pinned model identity, cost class, rule reference, attempt, estimated fixture cost, timestamp and started state. It then records succeeded/failed outcome. Missing durable evidence prevents dispatch. Exhausting allowed fallbacks records a terminal denial audit.

`createRoutedScriptedRunner` adapts the existing runner without editing it. The existing `beforeModelCall` suspension hook runs first; the added `authorizeModelCall` hook follows before transport. A suspension failure prevents both the second hook and HTTP transport. The additional hook is opt-in, and the preexisting hook order is preserved.
