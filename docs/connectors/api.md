# Workspace API factory contracts

All operations require the trusted IAP assertion header. The factory returns a
route map for explicit application registration. Route command bodies do not
accept `subject`, roles, raw tokens, or arbitrary OAuth scopes.

## Execute

`POST /v1/connectors/execute`

```json
{
  "tool": "calendar.listEvents",
  "payload": {
    "calendarId": "primary",
    "timeMin": "2026-10-15T00:00:00Z",
    "timeMax": "2026-10-16T00:00:00Z"
  },
  "taskId": "task-1",
  "stepId": "calendar",
  "callId": "call-1",
  "idempotencyKey": "key-1",
  "traceId": "trace-1"
}
```

Write requests also require an `approvalId`. Their payload must be the same
normalized object whose digest was approved. Read responses are classified
source arrays; create responses are `{ "id": "...", "kind": "document|event|draft" }`.

## Prepare and inspect an approval

`POST /v1/connectors/approvals/prepare` takes the execute command without an
approval ID. A trusted authorization callback must permit the caller, task, and
tool. It returns HTTP 201 with `{ approval, payload }`. It saves the normalized
payload and a five-minute, one-execution pending approval.

`POST /v1/connectors/approvals/read` takes `{ "approvalId": "..." }`. The requester
or a trusted approver can read it. The payload digest is checked before the
approval is returned. Another caller receives an ACL denial.

`POST /v1/connectors/approvals/decide` takes:

```json
{
  "approvalId": "approval-1",
  "decision": "approve",
  "expectedPayloadSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

Approver authority comes from the injected trusted resolver. A stale digest,
expired approval, unknown ID, or unauthorized actor cannot bind a decision.

## Incremental scopes

`POST /v1/connectors/scopes` takes `tool`, `state`, `codeChallenge`, and
`codeChallengeMethod=S256`. The selected manifest determines the scope. Existing
grants are retained and deduplicated. The user completes the existing OAuth
callback flow. Gmail send cannot request a scope through this endpoint.

## Safe failures

| Code                 | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| AUTH_REQUIRED        | Caller has no usable connection                              |
| AUTH_REVOKED         | Connection is stale, revoked, or ownership validation failed |
| STEP_UP_REQUIRED     | Incremental consent is required                              |
| RESOURCE_DENIED      | Caller lacks the source-system ACL                           |
| POLICY_DENIED        | Capability or classification policy denied the operation     |
| APPROVAL_REQUIRED    | Missing, edited, rejected, or incorrectly bound approval     |
| APPROVAL_EXPIRED     | Approval deadline passed                                     |
| DUPLICATE_CALL       | Concurrent or completed replay                               |
| QUOTA_EXHAUSTED      | Retry budget exhausted on quota responses                    |
| UPSTREAM_UNAVAILABLE | Transport/provider failure after bounded retries             |
| INVALID_REQUEST      | Command validation failed                                    |
| INVALID_RESPONSE     | Provider response violated the response contract             |

Provider bodies and secrets are not included in failure messages.

## Calendar creation example

Prepare this exact command for approval, then execute it with the returned
approval ID. Calendar notifications remain disabled by the adapter; the payload
has no option that can enable them.

```json
{
  "tool": "calendar.createEvent",
  "payload": {
    "calendarId": "primary",
    "summary": "Planning review",
    "description": "Discuss the approved planning brief",
    "start": "2026-10-15T10:00:00Z",
    "end": "2026-10-15T11:00:00Z",
    "attendees": ["alice@example.test"]
  },
  "taskId": "task-1",
  "stepId": "calendar-create",
  "callId": "calendar-call-1",
  "idempotencyKey": "calendar-key-1",
  "traceId": "trace-1"
}
```

Adding an attendee, changing the times, or editing the description after approval
invalidates the payload binding. A revoked Calendar connection prevents both
first execution and recovery of an unfinished create, even with a previously
approved payload.
