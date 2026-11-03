# SCH-03 operator real-queue test (AWAITING_OPERATOR)

Template: `templates/operator-approval.md`. This is a request, not an approval.

- Task and reason: SCH-03 VALIDATED needs a real Cloud Tasks delivery to the real worker endpoint.
- Environment: dev project, `asia-northeast1`, dev queue `aw-dispatch`, worker Cloud Run service.
- Source SHA / digest: SCH-03 result SHA, deployed worker image digest with the delivery route mounted and a real `DeliveryStore` (coordinator wiring), `task_queue` module applied from a dev root.
- Commands and inputs (operator runs):
  1. Review the plan of `task_queue` in dev. Apply after approval.
  2. Create a synthetic execution row (test tenant) and enqueue its envelope with the production client.
  3. Confirm the worker log shows one `accepted`, DB shows one handoff.
  4. Re-enqueue the same `dispatchId`: expect Cloud Tasks 409 (`duplicate`) or, after the task is deleted, a second delivery acknowledged as `already-terminal`.
  5. Direct `curl` to the worker URL with no token: expect 401 or 403 from Cloud Run IAM. With a token for a different service account: expect 403. With a token whose audience is another URL: expect 401.
  6. Stop the database (or point the store at a failing replica) and enqueue: expect 503 per attempt, task retried with backoff, no `accepted` log until recovery.
  7. Enqueue a v2 envelope: expect 503 retries and no poison record.
- IAM/scopes: `roles/cloudtasks.enqueuer` on the queue, `roles/iam.serviceAccountUser` on the dispatcher SA, `roles/run.invoker` on the worker, all for the dispatcher SA only.
- Cost and blast radius: one queue, a handful of tasks; dev only.
- Preconditions: local evidence in `evidence.md`; FND-05 OP-0..OP-4 done; no `allUsers` or `allAuthenticatedUsers` on the worker.
- Stop conditions: any 2xx for an unauthenticated call; any `accepted` without a DB row; task stuck beyond `maxRetryDuration`.
- Rollback: pause then delete the queue; remove the three IAM bindings (`terraform destroy -target` of the module).
- Evidence to capture (redacted): queue config describe, task names, worker logs with `outcome`, HTTP statuses, DB rows, IAM policy of the worker.
- Approval scope and expiry: dev only, single session. Approver, reference, timestamp: pending.
