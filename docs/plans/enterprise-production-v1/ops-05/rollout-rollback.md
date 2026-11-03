# Cohort rollout and rollback

Instructions for the operator. Nothing here is an approval, and no agent runs it. Rules come from `specs/07-operations-release.md` ("Release evidence") and `MILESTONE.md`.

## Rollout rules

1. Every capability flag defaults OFF. A capability turns on only for a cohort the owner has approved in writing, bound to the source SHA, image digests and migration version in the gate record ([gates/](gates/)).
2. A cohort advances on an approval record ([go-no-go-form.md](go-no-go-form.md)), never on elapsed time. A timer, a green dashboard or a closed issue is not an approval.
3. Advance one cohort at a time. Record the stop conditions first. Any security failure, unaccounted privileged effect, broken restore, missing authority evidence or missing owner approval is NO-GO and stops the advance.
4. Roll back application and config only when the schema allows it (table below). Otherwise run the forward repair.
5. The optional sandbox (AGT-05) and memory (AGT-06) capabilities stay DEFER. See "Optional capabilities" below.

## Flags and switches that must be OFF until approved

| Capability                                                       | Default-off mechanism                                                                                               | Source                                          | Approval needed to turn on                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Standing grants and agent-created routines (AGT-03, SCH-04)      | `AW_STANDING_GRANTS=on` plus a non-empty `AW_STANDING_GRANTS_O04_REF`; anything else denies issuance and resolution | `apps/api/src/authority-lifecycle/lifecycle.ts` | O04 (delegation scopes, depth, lifetime, scheduling rights) |
| Coordinator delegation (AGT-02)                                  | `delegationEnabled` is true only for the exact value `enabled`; empty or malformed disables                         | `apps/api/src/delegation/flag.ts`               | O04                                                         |
| Route slots (search, tasks, approvals, artifacts and the others) | per-route `AW_*` env slot                                                                                           | `apps/api/src/routes/slot.ts`                   | Gate G1 approval                                            |
| Sandbox and managed memory (AGT-05, AGT-06)                      | Capability guard denies without a sealed GO record bound to project, scope and image digest                         | `apps/api/src/capabilities/gate.ts`             | Separate operator evidence and record; stays DEFER          |
| Scheduler writer (SCH-01)                                        | `scheduler_owner` is `legacy` until switched with `switchSchedulerOwner`                                            | `apps/api/src/ports/schedule-row-claim*.ts`     | G2 approval                                                 |

The server wiring that reads some of these is done by the coordinator in `apps/api/src/server.ts`, outside this task. Verify the wiring and the exact env names on the release revision before relying on this table. That check is UNTESTED here.

## Migrations 0024 to 0030: rollback or forward repair

All seven are additive or expand-only. None may be edited once applied; repairs use a new migration number. Rollback notes are copied from each task's evidence.

| Migration               | Task   | App/config rollback                                                                                                                       | Schema rollback                                                                                                                                                                                                  | Otherwise                                                                                                                         |
| ----------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0024 standing grants    | AGT-03 | Leave `AW_STANDING_GRANTS` off. Nothing reads the tables while off.                                                                       | Not needed.                                                                                                                                                                                                      | Forward repair with a new migration number.                                                                                       |
| 0025 admission          | SCH-06 | Stop calling the admission service.                                                                                                       | Drop the four `admission_*` tables and the `schema_migrations` row, only after nothing reads them.                                                                                                               | Nothing reads them until wired.                                                                                                   |
| 0026 schedule row claim | SCH-01 | `switchSchedulerOwner(sql, 'rowclaim', 'legacy')`. It refuses while a row-claim transaction is in flight; retry. No cursor repair needed. | Expand-only, kept on rollback. To remove after a full rollback, drop the triggers, `scheduler_owner`, `schedules_next_due` and `schedules.next_due` in a later contract migration.                               | `schedule_runs` unique indexes make a repeated slot a no-op. A failed flip changes nothing (single transaction).                  |
| 0027 dispatch outbox    | SCH-02 | Stop calling `claimDueWithOutbox`; use the plain port. Drain or park pending rows (they stay `pending` and harmless).                     | Contract later by dropping the table, trigger and function.                                                                                                                                                      | Operator replay of abandoned rows is not built.                                                                                   |
| 0028 execution worker   | SCH-05 | Stop calling the worker and sweeper.                                                                                                      | Re-create the 0027 index only if no execution has more than one non-abandoned dispatch row, then drop the new tables. The migration dropped `dispatch_outbox_live_execution`, so this is a conditional reversal. | Work rows are forward-only data. Forward repair is the safer path once executions exist.                                          |
| 0029 graph execution    | AGT-01 | Older code ignores the new nullable columns.                                                                                              | Forward repair only. Drop the `tw_assignments_live_key` index to revert the key rule.                                                                                                                            | Duplicate live keys would fail the index (none expected). Any caller running the teamwork worker must call `applyGraphMigration`. |
| 0030 routines           | SCH-04 | Stop using the service (flag off).                                                                                                        | Drop `tw_routines` only after cancelling its schedules.                                                                                                                                                          | Needs 0024 applied.                                                                                                               |

Compatibility tests exist per task (see each `evidence.md`). A combined-revision rollback rehearsal over 0001..0030 has not been run: UNTESTED, AWAITING_OPERATOR.

## Application rollback

DEP-01's manual Deploy Dev workflow re-deploys a previous good SHA with its previous `aw-api` and `aw-web` digests under a separate approval reference (`dep-01/operator-approval.md`, rollback steps). The workflow runs no migration, so it cannot roll back schema. Record the previous digests before every advance; without them a rollback is not possible.

## Cohort advance procedure

1. Confirm the gate record for the exact SHA, digests and migration version has verdict GO from every required approver. Today every record is NO-GO ([gates/](gates/)).
2. Fill [go-no-go-form.md](go-no-go-form.md) for the cohort and the capability. The owner signs.
3. Prepare the live action with [templates/operator-approval.md](templates/operator-approval.md). The operator approves and executes it.
4. Observe against the stop conditions. Capture sanitized evidence and attach it to the record.
5. Advance, hold or roll back on a new approval. Elapsed time alone never advances a cohort.

## Optional capabilities: DEFER and provably disabled

AGT-05 (sandbox execution) and AGT-06 (managed memory) are DEFER. Their decision records state the verdict: [agt-05](../agt-05/gate-decision-record.md), [agt-06](../agt-06/gate-decision-record.md). The proof that they are disabled is the guard test suite, which the bundle builder lists (it does not re-run it):

- `apps/api/src/capabilities/gate.test.ts`: denies every capability with no record; allows only an exact project, scope, digest and capability match of a GO record; denies DEFER, NO-GO, expired and tampered records.
- `apps/api/src/capabilities/sandbox.test.ts`: "denies by default without touching the sandbox or any worker fallback"; offline fake results never move the gate.
- `apps/api/src/capabilities/memory-port.test.ts`: "is denied by default and never reaches the adapter"; task recovery works with no memory adapter.

No GO record exists in the repository. Run `pnpm exec vitest run --project @agent-works/api apps/api/src/capabilities` on the release revision and attach the result; that run is part of operator evidence for G3.
