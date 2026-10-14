# Migration numbers

`openDatabase` applies `0001_audit.sql` and `0002_ask_reservation.sql`. A number is never reused.

| Number | Name              | Status                                                                 |
| ------ | ----------------- | ---------------------------------------------------------------------- |
| 0001   | `audit`           | Applied by `apps/api/src/db.ts`.                                       |
| 0002   | `ask_reservation` | Applied by `apps/api/src/db.ts` (PR #35). Do not use `0002_tasks`.     |
| 0003   | `approvals`       | Reserved by #51.                                                       |
| 0004   | `workflow`        | Reserved by #51.                                                       |
| 0005   | `credentials`     | Reserved by #51.                                                       |
| 0006   | `tasks`           | Reserved by #39 for the task ledger (#46). File name `0006_tasks.sql`. |
| 0007   | `task_dispatch`   | Task dispatch (#119). File name `0007_task_dispatch.sql`.              |
| 0008   | `task_history`    | Persisted task event reads (#97). File name `0008_task_history.sql`.   |

The task ledger applies `0006`–`0008` under its migration lock. `0008` indexes task history stored in the existing JSON outbox; dispatch envelopes use the existing `task_deliveries.payload` column. No public API schema changes.

`0009_approval_payload.sql` persists the canonical approval-bound delivery payload. The approval store applies it under its migration lock after `0003`.

The next free number after these reservations is `0010`.

## Offline schedules and event triggers

`0013_schedules.sql` is applied by `scheduling/migration.ts` under advisory
transaction lock 7013. It records its application in `schema_migrations`.
It creates `schedules`, `event_triggers`, `schedule_runs`, `received_events`
and the append-only `schedule_audit`. Timer slots are unique per schedule and
fire time; verified event receipts are unique per source and source event ID.
The service uses the same lock for atomic claims and fenced run updates.
Do not reuse migration number `0013`.
