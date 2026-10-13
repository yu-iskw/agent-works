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

The next free number after these reservations is `0008`.
