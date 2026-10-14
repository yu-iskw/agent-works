# Structured analytics (issue 147)

This offline bundle provides approved semantic metrics, guarded read-only SQL,
local execution, cost admission, and human validated immutable report versions.
No cloud credentials, connector changes, web application changes, or network
calls are required. The fixture engine evaluates the parsed AST directly.

## Entry points

- `POST /v1/analytics/query`: semantic metric request or guarded free SQL.
- `GET /v1/analytics/metrics`: definitions visible through current dataset grants.
- `GET /v1/analytics/reports`: versions owned by the verified caller.
- `POST /v1/analytics/reports`: save a human validated query as a new version.
- `POST /v1/analytics/reports/rerun`: rerun a frozen version with current authority.
- `aw analytics`: CLI for all five operations.
- `analyst@1.0.0`: task skill for existing schedule dispatch.

Routes require explicit trusted dependency injection, like the existing schedules
and governance bundles. Omitting analytics dependencies registers no analytics
routes. The default analyst skill is discoverable but fails closed until a service
and trusted authority resolver are configured.

## Semantic query example

```json
{
  "kind": "metric",
  "metric": "revenue",
  "dimensions": ["region"],
  "filters": [{ "column": "day", "op": ">=", "value": "2026-10-01" }],
  "limit": 20,
  "maxBytes": 100000
}
```

This compiles the approved SQL template using named parameter bindings. It never
accepts an LLM-generated substitute for a metric request. Unknown metrics and
unapproved dimensions fail. Every compiled query still passes the SQL guard.
The fixture returns east revenue 40 and west revenue 20.

## Guarded free SQL example

```json
{
  "kind": "sql",
  "sql": "SELECT region, amount FROM approved.sales WHERE day >= @start LIMIT 20",
  "params": { "start": "2026-10-01" },
  "limit": 20,
  "maxBytes": 100000
}
```

Free SQL is marked `vetted: false` in the response, saved version, and query audit.
Report validation does not retroactively promote free SQL to a vetted metric.
The request's row limit can only tighten the server limit.

See [SQL dialect](sql-dialect.md), [operations](operations.md),
[integration](integration.md), and [acceptance evidence](acceptance.md).
