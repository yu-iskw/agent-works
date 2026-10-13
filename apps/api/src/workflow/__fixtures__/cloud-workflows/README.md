# Cloud Workflows golden examples

These examples contain synthetic IDs and an `.example.test` broker endpoint.
They are checked by `cloud-workflows.test.ts` without a cloud transport, OAuth
credentials, a database server, or a real external write.

| Fixture                                    | Contract checked                                                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `definition.json`                          | Fixed OIDC broker call, bounded HTTP retries, reusable authenticated callback, timeout loop, fail-closed dispatch |
| `create-requests.json`                     | Persist checkpoint first; list executions before non-retried create                                               |
| `duplicate-callback-requests.json`         | Reauthorize and reconcile delivery even when the durable signal is a duplicate                                    |
| `expired-authorization-requests.json`      | Denied authorization emits no cloud request                                                                       |
| `cancel-requests.json`                     | Commit ledger cancellation before sending remote cancellation                                                     |
| `crash-recovery-requests.json`             | Recover a lost create response by listing the active labeled execution                                            |
| `successful-ledger-events.json`            | Receipt/outbox commit precedes final completion                                                                   |
| `expired-authorization-ledger-events.json` | Expired execution authorization blocks the task without a write                                                   |
| `recovered-ledger-events.json`             | Repair a lost receipt from external lookup without executing again                                                |
| `cancel-mid-write-ledger-events.json`      | Preserve terminal cancellation while retaining the completed external receipt                                     |

The execution-list response uses `view=FULL` so the adapter can inspect labels.
Task labels are deterministic SHA-256 values truncated to Google's label limit;
they do not contain subjects, objectives, approvals, or credentials. Execution
arguments contain only a task ID. External idempotency keys bind task ID, step ID,
and canonical payload digest.

The callback list API returns a singular `/callback/{id}` resource name while
callback delivery uses a plural `/callbacks/{id}` URL. This distinction is checked
explicitly; callback URLs from an arbitrary response are never followed.

Primary references used to review request shapes:

- [Execution create](https://docs.cloud.google.com/workflows/docs/reference/executions/rest/v1/projects.locations.workflows.executions/create)
- [Execution list](https://docs.cloud.google.com/workflows/docs/reference/executions/rest/v1/projects.locations.workflows.executions/list)
- [Callback list and resource names](https://docs.cloud.google.com/workflows/docs/reference/executions/rest/v1/projects.locations.workflows.executions.callbacks/list)
- [Authenticated callback waits](https://docs.cloud.google.com/workflows/docs/creating-callback-endpoints)

Review a source change and its golden diff together. Do not accept regenerated
fixtures solely because they make a test pass. These fixtures check the offline
contract; they do not establish cloud compilation, IAM availability, latency, or
end-to-end durability of a deployed broker.
