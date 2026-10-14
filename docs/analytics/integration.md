# Ports, registration and schedule integration

## Offline composition

Build the domain package first, as root prebuild and pretest already do. Exclusive
issue paths prevent changing package export maps and domain index registration, so
`apps/api/src/analytics/domain.ts` imports the built domain contracts and declaration
files directly. There are no duplicated domain schema implementations in the API.

```ts
import { createAnalyticsService } from './analytics/service.js';
import { createFixtureEngine } from './analytics/fixture-engine.js';
import { createMemoryAnalyticsPort } from './ports/memory/analytics.js';
import { createMemoryBudgetPort } from './finops/memory-budget.js';

const port = createMemoryAnalyticsPort();
await port.putDataset(approvedDataset);
await port.putMetric(approvedMetric);
const service = createAnalyticsService({
  port,
  engine: createFixtureEngine(fixtureRows),
  budget: {
    port: createMemoryBudgetPort(),
    policy: localBudgetPolicy,
    microsPerMillionBytes: 1000,
  },
  limits: { maxRows: 1000, maxJoins: 2, maxBytes: 100000 },
  now: () => new Date(),
});
const analytics = { verify: verifyIap, service, authority: trustedAnalyticsAuthority };
const routes = createRouteTable({ ...existingDeps, analytics }, existingFlags);
```

`approvedDataset`, `approvedMetric`, `fixtureRows`, `localBudgetPolicy`, and the IAP
and directory dependencies above are supplied by the composition root. A runnable
fixture composition is exported as `analyticsFixture()` for tests and local demos.
There is no public route to modify metric definitions or allowlists. Operators seed
those through the port, keeping catalog administration outside user query authority.

## Postgres

Substitute `createPostgresAnalyticsPort(sql)` for the memory catalog. The adapter
uses migration `0015_analytics.sql`, protected by the same advisory lock as its
transactions. Migration records live in `schema_migrations`. Failed migration
promises are removed from the pool cache so a later attempt can recover.

The adapter follows the existing schedules transactional state-driver pattern:
read validated JSON payloads, apply the shared store operation, and persist changes
under a Postgres transaction and advisory lock. Report and audit rows are append-only.
Datasets and metric definitions can be revised by trusted operators. Memory and
Postgres use the same store validation and port acceptance contract.

The catalog is intended for offline-sized fixtures and approved report metadata.
Its state-loading approach is deliberately consistent with existing repository
adapters; large audit retention and streaming export need a later storage design.

## BigQuery

`createBigQueryEngine(transport, { enabled, location })` uses a typed injected
transport. No real transport is instantiated by this bundle. Disabled mode makes
zero transport calls; enabled mode requires `asia-northeast1`. Dry runs pass exact
SQL, scalar bindings, `useLegacySql: false`, explicit location and the admitted
`maximumBytesBilled`. The fake tests these fields and malformed estimate handling.

A later operator composition can supply an authenticated SDK transport. Real project
execution must be explicitly enabled. That operator must retain evidence for approved
views, row-level and column ACLs, service account privileges and dry-run billing
semantics. The fixture adapter does not establish any of that cloud evidence.

## Existing schedules

Register a configured `createAnalystSkill(() => ({ service, authority }))` in the
existing skill registry. Its manifest is `analyst@1.0.0`, with the single read-only
tool `analytics.report.rerun@1`. Its input is exactly a report version reference and
a byte cap. No SQL generation, catalog edits or report validation occur in dispatch.

Use the existing scheduleSpec with sponsor Alice, skill analyst version 1.0.0,
source allowlist containing approved.sales, and task input:

```json
{
  "versionId": "14700000-0000-4000-8000-000000000002",
  "maxBytes": 100000
}
```

The schedule's sponsor, current privilege ceiling, expiry and dispatch checks remain
in issue 143 code. The analyst resolves fresh trusted dataset authority and calls
`executeAnalyticsReportTask` with the dispatched task ID for issue 137 scope.
Concurrent dispatch for the same task shares one execution. Successful duplicate
dispatch returns the recorded result without another query charge. Failed dispatch
can be retried, obtaining fresh authorization and a new audited estimate.
