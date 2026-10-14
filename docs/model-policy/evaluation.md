# Delegation evaluation

```sh
node evals/delegation/report.mjs
```

The report loads existing dev/adversarial cases and the #136 offline runtime/scorer read-only. It scores a single orchestrator baseline, then decomposes applicable successful retrieval cases into one child per authorized source using the new orchestrator, memory evidence port, root budget port and independent citation verifier. Fault, hostile and write scenarios retain the deterministic baseline path.

Both arms use the same dataset and scorer. The report includes quality metrics, ACL group breakdowns, per-case measurements, applicability, child/verified/rejected counts, fixture cost allocations and elapsed time. It is written to `evals/delegation/reports/comparison.json`, an ignored local/CI artifact.

`mode: report-only`, `gating: false`, `evidence: offline-fakes-only` and `realServicesGatePassed: false` make the scope explicit. Metric differences do not set an exit failure or change routing/delegation configuration. A failure to run the report is recorded as unavailable; it does not imply a quality pass.

The existing workspace test run discovers a small API-contract test bridge that imports the report test. This produces the report in the existing CI test job and prints its path/status. There is no new workflow or release gate. Report generation can also be run directly with Node 24 after the domain package is built.

## Limits

Synthetic fixture answers and costs are not real model evidence. Elapsed time measures local fixture execution, not provider latency. Only a subset of retrieval cases is decomposed; copying other baseline observations must not be described as an independently executed delegated arm. Dataset keys remain subject to the existing harness's review limitations.

Benchmark fixture derivation is separate from this comparison. Its identical baseline/candidate observations demonstrate schema and gate behavior only. Real routing promotion requires an operator-approved measured artifact for the pinned model/version/region and task class.
