# Routing and delegation persistence

The only migration added is `apps/api/migrations/0014_model_routing_delegation.sql`. `applyModelRoutingMigration` initializes the existing ledger and registers this migration under an advisory transaction lock. It intentionally skips unrelated bundle migrations.

| Table                     | Evidence                                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `model_inference_records` | Inference identity, task/trace, pinned model/version/region/zone, outcome and validated payload         |
| `model_routing_audits`    | Model denial, benchmark-disabled and fallback-exhausted evidence                                        |
| `delegation_edges`        | Parent/child/root IDs, trace, depth, computed authority hash, allocated budget and verification outcome |
| `delegation_audits`       | Delegation denial/execution/verification evidence                                                       |

Indexes support task/trace and parent/root queries in insertion order. Database checks reject empty pinned coordinates, invalid state/depth/hash and a verified edge lacking evidence. Payloads store structured evidence, not raw child output, prompts or credentials. The result digest links output to verification without placing its text in the edge.

Memory ports clone query results and validate writes with the same domain schemas. PostgreSQL ports validate parsed payloads, use advisory locks for identity creation/audits and row locks for terminal transitions. Equal starts/audits are idempotent; conflicting identities and terminal rewrites fail.

Shared contract suites exercise pinned identity, task query isolation, competing identities, verified-state evidence, unknown completion, immutable terminal state and audit idempotency. The same suites run on memory and actual PostgreSQL.

Run Postgres tests with `/tmp/issue135-bin` first on `PATH` when using the prepared local wrapper. Tests allocate RAM-backed disposable data directories and clean up their own containers. They require access to Docker and localhost; do not prune Docker to make the suite run.
