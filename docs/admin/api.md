# Admin API and CLI contract

The operator drill has not run. This local interface does not satisfy the
P3-ADM gate or RFC-001 §21. Use the
[global agent stop runbook](../runbooks/global-agent-stop.md) for incident actions.

## Read endpoints

`GET /v1/admin/suspensions` returns the latest revision of every suspension
and every capability version. Inactive and expired suspension records remain
visible. Clients use the revision displayed here for optimistic concurrency.

```json
{
  "suspensions": [],
  "versions": []
}
```

`GET /v1/admin/history` returns the immutable audit sequence, including control
plane mutations and denied invocations. A history row contains an event ID,
event type, verified actor, occurrence time, reason, canonical SHA-256 digest,
task ID or null, trace ID, and structured details. The console renders audit
reasons and targets as escaped text. Responses and pages are not cached.

Every read requires a fresh trusted-directory `Admin` role. An IAP assertion
with an unrecognized signer, bad audience, expiry or no subject is rejected by
the existing verifier. An authentic assertion belonging to a non-admin yields 403. Role headers do not participate in authorization.

## Suspend

`POST /v1/admin/suspensions` accepts JSON with this shape:

```json
{
  "commandId": "5a8c974b-29b8-4dfc-a73a-03c662c23c01",
  "action": "suspend",
  "target": { "scope": "global", "id": "*", "version": null },
  "reason": "Local incident response",
  "expiresAt": null,
  "expectedRevision": 0
}
```

`expectedRevision: 0` creates a target that does not exist. Updating a known
scope/ID/version requires its current revision. The same target can be suspended
again with a new reason or future expiry; that appends another revision.

Only agent, skill and tool targets can carry `version`. Global must use `*`
and a null version. Team IDs come from the trusted directory groups carried by
the runtime, and user IDs are verified IAP subjects. Model IDs are the exact
configured model labels. IDs and versions are case-sensitive.

An expiry must be a future UTC ISO instant. A past expiry is a 409 conflict,
not a successful no-op. `reason` is trimmed, nonempty and limited to 2000
characters; IDs and version labels are trimmed and limited to 256 characters.
Commands are strict: additional actor, role or other fields are rejected.

## Resume

The same endpoint accepts `action: "resume"`, the exact target and its current
revision. A resume requires a previously suspended target and null expiry.
The reason records why work may proceed again.

```json
{
  "commandId": "756cf999-34c8-4ee3-b336-a526e0d3edfa",
  "action": "resume",
  "target": { "scope": "global", "id": "*", "version": null },
  "reason": "Operator confirmed local recovery",
  "expiresAt": null,
  "expectedRevision": 1
}
```

A resume does not restore a revoked version. A remaining team/user/capability
suspension can still deny a call after the global suspension is resumed.

## Capability state

`POST /v1/admin/versions` accepts an immutable capability pin and a state.

```json
{
  "commandId": "c2f7f758-af5b-4a4a-bf9e-0804a4d2f682",
  "pin": { "kind": "skill", "id": "incident-analysis", "version": "1.0.0" },
  "state": "revoked",
  "reason": "Local leaked-output exercise",
  "expectedRevision": 2
}
```

Kinds are `agent`, `skill`, `tool`. States are `draft`, `published`,
`deprecated`, `revoked`. A new pin starts as draft; published and deprecated
pins can be revoked directly. See [versioning](versioning.md).

## Replies, retries and conflicts

A successful mutation returns `{ "record": ..., "replay": false }`. Repeating
the same normalized command ID, payload and actor returns the original record
with `replay: true`; it writes no second audit event. This remains true after
later revisions change the target's state.

A command ID is shared across all targets and kinds. Reusing it for a different
reason, target, pin, state or actor returns 409. A stale expected revision or
illegal state transition also returns 409. Read the state again and review a
new command before retrying; do not silently rewrite the expected revision.

| Status | Meaning                                        | Operator action                                          |
| ------ | ---------------------------------------------- | -------------------------------------------------------- |
| 200    | Mutation committed or identical retry replayed | Preserve command ID and record                           |
| 400    | Strict schema validation failed                | Correct and review the command                           |
| 401    | Missing/invalid verified assertion             | Authenticate through IAP                                 |
| 403    | Directory role is absent, stale or unavailable | Ask a directory administrator through the normal process |
| 409    | Stale revision, reused ID or illegal lifecycle | Reload and review                                        |
| 413    | HTTP body exceeds 16 KiB                       | Reduce the command                                       |
| 415    | Mutation is not JSON                           | Use application/json                                     |
| 503    | Storage/verification unavailable               | Preserve the command and restore service                 |

There is no mutation using a GET endpoint. Browser form content types are
rejected at the API, and the web interface additionally uses an unpredictable
256-bit CSRF token, HttpOnly/SameSite=Strict cookie, same-origin check and a
confirmation page. The API rechecks directory authorization at final apply.

## CLI

Read state through a configured local API:

```sh
aw admin list --url http://127.0.0.1:8084
aw admin history --url http://127.0.0.1:8084
```

Save a command from one of the strict schemas to a JSON file, review it, then:

```sh
aw admin suspend stop.json --confirm --url http://127.0.0.1:8084
aw admin resume resume.json --confirm --url http://127.0.0.1:8084
aw admin version version.json --confirm --url http://127.0.0.1:8084
```

The command file is sent as reviewed. Suspension file actions must match the
CLI subcommand. The assertion is read from `AW_IAP_ASSERTION`; do not place it in
the command file, print it, or commit it. The CLI prints successful JSON records
and controlled status messages; raw provider errors and assertions are omitted.
Exit codes are 0 for success, 1 for usage/confirmation, 2 for transport/server
failure, and 3 for a forbidden directory role.
