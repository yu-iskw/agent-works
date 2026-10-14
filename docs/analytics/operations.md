# Analytics operations and immutable reports

## Authorization

The route verifies IAP before asking the trusted directory dependency for roles
and dataset grants. Only the exact `analyst` role permits analytics operations.
Headers such as `x-role`, `x-user`, and `x-datasets` do not grant access. Body roles
or grants are ignored for authorization and fail strict query input validation.
An absent dataset grant returns 403 before dry run and execution.

Metric listing is filtered by grants. Version listing is restricted to the caller's
ownership. Reruns require both ownership and current grants; a saved report never
acts as a permanent authorization token. Revoking a column from the catalog or
raising its classification affects subsequent reruns of frozen SQL.

## Cost admission

The pipeline is guard → dry run → byte cap → issue 137 reservation → execution →
audit → concurrency release. An over-cap estimate is denied before execution and
recorded with its safe reason and estimated bytes. Malformed, negative, fractional
or unsafe integer estimates fail closed. Auditing failure prevents a success reply.
Engine errors are mapped to safe API errors and never placed verbatim in evidence.

Issue 137 task and user scopes receive the verified subject, task identity and UTC
date window. A scheduled report uses its existing dispatched task ID. The byte
price is integer micros per million bytes, rounded up. Local query budget admission
checks `reservation.exceeded` even under observe mode. It never disables billing or
changes the ADR 0003 cloud spend policy. All fixture money amounts remain explicitly
unapproved PLACEHOLDER configuration.

Audit records contain query and parameter hashes, subject hash, timestamp, vetting
state, estimate, outcome, reason, classified column names, and masked result rows.
Raw SQL and parameter values are excluded from query audit and SIEM. Frozen SQL and
parameters necessarily exist in report storage; use storage access controls and
avoid sharing raw report metadata with unrelated users.

## Save and edit

```json
{
  "reportId": "14700000-0000-4000-8000-000000000001",
  "title": "Revenue by region",
  "humanValidated": true,
  "query": {
    "kind": "metric",
    "metric": "revenue",
    "dimensions": ["region"],
    "filters": [{ "column": "day", "op": ">=", "value": "2026-10-01" }],
    "limit": 20,
    "maxBytes": 100000
  }
}
```

A save executes the guarded query once, then stores the frozen SQL, scalar
parameters, vetting state, metric name, classification, owner and validator,
validation timestamp and SHA-256 plan hash. The authenticated caller supplies the
human validation action. No LLM or background task can supply validation through
the analyst skill. A false or absent `humanValidated` value fails.

Editing means another save with the same reportId and a new query or title. The
port allocates the next version atomically and creates a new UUID. Earlier rows are
immutable. Hashing preserves exact SQL bytes and canonicalizes parameter keys.
Postgres triggers reject UPDATE, DELETE and TRUNCATE of reports and query evidence.
Concurrent version allocation is serialized across independent pools.

## Rerun

```json
{
  "versionId": "14700000-0000-4000-8000-000000000002",
  "maxBytes": 100000
}
```

Rerun uses only frozen SQL and params. It does not recompile current metric templates.
It verifies the plan hash, rechecks authority and the current catalog, obtains a new
estimate, applies current limits and budgets, and audits a new execution.

## CLI

```sh
aw analytics metrics --url http://127.0.0.1:8084
aw analytics query query.json --url http://127.0.0.1:8084
aw analytics save save.json --confirm --url http://127.0.0.1:8084
aw analytics reports --url http://127.0.0.1:8084
aw analytics rerun rerun.json --url http://127.0.0.1:8084
```

The CLI uses the configured IAP assertion without displaying it. HTTPS is required
except for loopback endpoints. Credentials in URLs and redirects are rejected.
Exit codes: 0 success, 1 usage or missing confirmation, 2 transport/API/input error,
3 forbidden. Report save requires both CLI confirmation and the validated JSON body.
