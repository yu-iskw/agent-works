# Offline suspension and version control plane

This console implements issue #134, RFC-001 §§10.3, 15.3, 16.3, 18 Phase 3,
and 19.1. It is an offline control plane for seven kill-switch scopes and
immutable capability version pins. It closes no D-id in the Phase 3 readiness
matrix and grants no production autonomy.

**The operator drill has not run.** Local unit, server and browser tests do not
satisfy RFC-001 §21 “kill switches exercised” or the P3-ADM operator gate.
Follow the accepted [global agent stop runbook](../runbooks/global-agent-stop.md)
for the incident sequence. These documents describe console mechanics and do not
replace that runbook.

## Entry points

- Browser: `/admin` on the existing web service. All forms first show a review
  page. The final button submits the exact target, pin, reason, expiry, revision
  and command ID to the API.
- API: `GET /v1/admin/suspensions`, `GET /v1/admin/history`,
  `POST /v1/admin/suspensions`, `POST /v1/admin/versions`.
- CLI: `aw admin list`, `aw admin history`, `aw admin suspend`,
  `aw admin resume`, `aw admin version`. Mutation commands require `--confirm`.

The browser and CLI forward a verified IAP assertion; they do not choose app
roles. The API looks up the verified subject in the trusted directory for every
admin request. Only the directory's `agent-admins@company.example` group maps to
`Admin`. Employee, reviewer, arbitrary role headers and client-supplied actor or
role fields cannot grant administration.

The stock fake directory seeds employee access, not administrators. Browser
smokes create their own local, trusted directory fixture with an explicit admin
membership and a signed fake-IAP token. They do not modify real directory groups
or call a cloud service.

## Supported controls

| Scope  | Target ID                  | Optional version  | Effect                              |
| ------ | -------------------------- | ----------------- | ----------------------------------- |
| global | `*`                        | none              | Deny new admissions and invocations |
| team   | trusted directory group ID | none              | Deny members of that team           |
| user   | verified IAP subject       | none              | Deny that user                      |
| agent  | `api`                      | a release version | Deny the pinned agent               |
| skill  | e.g. `incident-analysis`   | a release version | Deny the pinned skill               |
| model  | e.g. `gemini`              | none              | Deny that model                     |
| tool   | e.g. `ticket.create`       | a release version | Deny the pinned tool                |

An unversioned capability suspension matches every version of that capability.
A versioned suspension matches only that immutable pin. An unrelated user, team,
model or pin is unaffected. Scopes combine with OR: any active matching
suspension denies the call.

Expiry is an ISO UTC instant. A suspension expires exactly at that instant.
Expiry does not erase its record or history. A resume appends a new inactive
revision. It never deletes a suspension or an audit record.

## Runtime behavior

The API entry point binds a request-scoped enforcer. Queued skill dispatch binds
its trusted caller, current directory groups, pinned skill version, agent
version and configured model. The wrapper preserves the existing skill and
registry interfaces. Parallel requests use separate asynchronous contexts.

The broker runs its injected hook immediately before its external transport.
The scripted runner runs the hook before its model request. The ADK runner runs
the hook before every model turn, including runners created internally by the
Ask route. State is reread for each check. There is no allow cache after an admin
change and no automatic model fallback or capability migration.

A check denies if the store cannot be read, the trusted invocation context is
incomplete, a pin is unknown or unpublished, a version is revoked, or a matching
suspension is active. Denial preserves a correlation record with the task ID,
trace, actor, reason, call kind and canonical digest. When the suspension store
cannot accept that record, the API's independent task ledger receives the same
event ID through its audit outbox. If both storage systems fail, the call still
stops; operators must recover storage before treating audit delivery as complete.

The admin API remains reachable during a global stop so an authorized operator
can inspect history and resume safely. Health checks remain readable. A stopped
queued skill reports the dispatcher's existing `revoked` result and transitions
to `BLOCKED_AUTH`. Completed receipts are reconciled before skill dispatch; they
are never blindly replayed because a suspension or version state changed.

A kill switch prevents calls that have not crossed the enforcement boundary.
It does not roll back or cancel a model request or external write already in
flight. Preserve its receipt and follow the runbook's reconciliation steps.

## Further reading

- [API and CLI contract](api.md)
- [Capability lifecycle and controlled errors](versioning.md)
- [Storage, transactions and audit history](storage.md)
- [Offline verification and operator evidence](verification.md)
- [Global agent stop](../runbooks/global-agent-stop.md)
