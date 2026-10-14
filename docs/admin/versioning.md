# Capability versions and controlled stops

The operator drill has not run. This implementation is local evidence only and
does not satisfy P3-ADM or RFC-001 §21. Incident response follows the
[global agent stop runbook](../runbooks/global-agent-stop.md).

## Immutable publication contract

A pin is `(kind, id, version)`. Tasks continue to use that exact pin; the control
plane never selects a replacement. Changing the state of `incident-analysis@1`
does not change `incident-analysis@2` or a task's recorded pin.

RFC-001 §10.3 describes the full publication process:

`DRAFT → SECURITY_REVIEW → EVALUATED → APPROVED → PUBLISHED → DEPRECATED → REVOKED`.

This operational console stores the four states requested by issue #134.
Security review, evaluation and approval remain prerequisites in the external
release process; the console's publish button is not evidence they occurred.
Published bundled capabilities are registered by the trusted release bootstrap.
Unknown capabilities start as draft and cannot execute until an authorized
publication change occurs.

| Existing state | Allowed next states | Invocation behavior                  |
| -------------- | ------------------- | ------------------------------------ |
| absent         | draft               | Denied                               |
| draft          | published, revoked  | Denied                               |
| published      | deprecated, revoked | Allowed while unsuspended            |
| deprecated     | revoked             | Existing immutable pins may continue |
| revoked        | none                | Denied permanently                   |

Repeating a state with a new command is rejected. A retry of the original
command ID is idempotent and returns the originally committed result. Moving
backward, restoring a revoked pin, or changing a pin in place is rejected.
Deprecation does not migrate running tasks. Publication is an authorization
fact, not a grant of source access, tool approval or directory membership.

## Release bootstrap

The API registers the bundled API agent, Ask skill, Drive search tool,
incident skill and ticket tool through draft and published revisions. Each
registration revision has one audit record identifying `service:release`.
Existing records are always honored, including draft, deprecated and revoked.
Restarting the API cannot resurrect a revoked version.

Concurrent startup uses optimistic revisions. A losing bootstrap instance
honors the winner's state. If startup stops after creating draft, later startup
leaves it denied; an operator must investigate and explicitly publish it. Store
unavailability fails startup closed rather than inventing a memory production
control plane.

Bundled release records are distinguishable from interactive changes by actor,
reason and command ID. The Postgres history stores both in the same immutable
sequence. The web console exposes their revisions for subsequent admin changes.

## Runtime error contract

An invocation stop is an `InvocationStopped` error derived from the existing
runner error family. Its message and `code` are stable machine-readable labels.
The denial audit carries the same reason.

| Code                           | Trigger                                          |
| ------------------------------ | ------------------------------------------------ |
| SUSPENSION_STORE_UNAVAILABLE   | Snapshot cannot be read or interpreted           |
| SUSPENSION_CONTEXT_MISSING     | No trusted subject/model/task invocation context |
| CAPABILITY_VERSION_REVOKED     | Any relevant immutable pin is revoked            |
| CAPABILITY_VERSION_UNPUBLISHED | A pin is absent or draft                         |
| INVOCATION_SUSPENDED           | An active matching scope suspension exists       |

The existing HTTP Ask surface maps model stops to its controlled
`runner_failed` response. Read-tool stops use the existing `retrieval_failed` response. Admission stops map to `unavailable`. Queued skills
expose the existing `revoked` result so the task dispatcher chooses
`BLOCKED_AUTH`, preserving the task's pin and history. No new task route or
retrieval adapter is required.

Even if a legacy skill catches and normalizes an inner model/tool failure, the
request-scoped wrapper latches the enforcement stop. It cannot report completion
or continue model turns as though the denial were an ordinary transient error.
Ordinary transport/skill errors retain the existing failure semantics.

## No replay and no automatic migration

The broker's completed receipt path runs before the new invocation hook.
Returning a receipt does not invoke a tool again. Intended-but-uncompleted calls
still pass through the hook before their transport and fail if revoked.

The existing dispatcher checks its durable receipt and external reconciliation
before invoking the pinned skill. A known completed write is settled with its
receipt. A missing receipt is not evidence a write failed: follow the runbook's
reconciliation instructions and existing retry limits.

A resume removes only one suspension. It never resets approval executions,
changes idempotency keys, replaces pins or requeues a completed side effect.
A revoked task stays blocked. Explicit migration requires separate policy and
human authorization; this control plane provides none.
