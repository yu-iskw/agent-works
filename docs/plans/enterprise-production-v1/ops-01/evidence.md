# OPS-01 evidence: execution correlation and safe instrumentation

- Task / owner / date / status: OPS-01 / worker / 2026-11-03 / READY_FOR_REVIEW (not VALIDATED)
- Base SHA / result SHA / draft PR: `origin/epv1/integration` / see commit on `epv1/ops-01-correlation` / none
- Scope: `apps/api/src/telemetry/{correlation,redaction,instrument}.ts`, `apps/api/src/routes/tasks.ts`, `tasks-telemetry.ts`, `apps/api/src/suspension/enforcement.ts`, `apps/web/app/tasks/handler.ts`. No migration.

## Data shape

`Correlation` has ten keys: request, scheduleOccurrence, task, graphRevision, graphNode, bot, grant, attempt, model, effect. Every key is always present. A key not yet known is the string `unknown`, so a gap is visible in the trace instead of silently absent. A nested span inherits and refines its parent's known ids.

Metric labels are the closed set `route`, `outcome`, `kind`, each with an enumerated value list. Any other value becomes `other`. Ids appear only in span and log records.

Redaction is applied inside `createTelemetry`, before any sink sees data. Values under keys matching token, secret, password, authorization, cookie, assertion, api key, prompt, source, body, content, text, args, input, objective, signature are replaced with `[REDACTED]`. JWT, Bearer and `sk-`/`ghp_`-style strings are scrubbed from every string. Errors are reduced to their name.

## Acceptance mapping

| Criterion                                                                      | Test                                                                                                         | Result                     | Local or live |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------- | ------------- |
| Secret, token, source, prompt, tool-arg fixtures absent from logs and spans    | `telemetry/instrument.test.ts` "never emits token, prompt, source or tool argument values"                   | PASS                       | local         |
| Bearer assertion absent from task route spans, logs, metrics                   | `instrument.test.ts` "keeps the task id out of metric labels..."                                             | PASS                       | local         |
| Bounded metric label set                                                       | `instrument.test.ts` "emits only the bounded label set" (50 distinct ids, 1 label set)                       | PASS                       | local         |
| Trace links task to policy and effect/suspension decision                      | `instrument.test.ts` "joins the submit span, its policy decision and a later suspension decision by task id" | PASS                       | local         |
| Unknown correlation explicit                                                   | `instrument.test.ts` "records unknown ids explicitly" and nested merge                                       | PASS                       | local         |
| Exporter failure cannot bypass authorization or fabricate success              | `instrument.test.ts` "instrumentation failure is not an authorization or effect input" (3 tests)             | PASS                       | local         |
| Web owner route observed without ids or assertion; observer throw keeps denial | `apps/web/app/tasks/observe.test.ts`                                                                         | PASS                       | local         |
| Trace-to-ledger join in the broker effect path                                 | Not in this write set                                                                                        | UNTESTED, see wiring below | n/a           |

## Commands

- `pnpm exec vitest run apps/api/src/telemetry apps/api/src/suspension apps/api/src/routes apps/api/src/skills apps/web/app/tasks`: 38 files, 403 tests, exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm knip`: exit 0 apart from a pre-existing `apps/web` configuration hint.
- `eslint` on touched files: 0 errors. Warnings are `security/detect-object-injection` on fixed-key lookups.

## Compatibility, rollback

Every new parameter is optional and defaults to a no-op telemetry. Removing the wiring restores prior behavior. No schema change.

## Operator work

None required for the local deliverable. A real exporter (OTLP/Cloud Trace) and dashboards are operator-side: AWAITING_OPERATOR.
