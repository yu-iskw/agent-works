# Reviewing workspace writes

A write approval binds caller, task, step, versioned tool reference, target
resource, and the canonical SHA-256 of the normalized payload. The execution
store limits the approval to one execution. Changing a Docs destination, body,
or title; Calendar time, attendee list, or description; or Gmail recipient list,
subject, body, or thread changes the digest.

The web view checks the persisted payload digest before displaying decision
controls. It shows every supported payload field and the bound digest. A diff
card can show before/after values; a new draft shows `Not present` as the prior
value. HTML escaping applies to payload text, including hostile email or Drive
source markup copied into the draft.

The form uses a separate HttpOnly SameSite=Strict CSRF cookie and matching hidden
form token. A supplied Origin must match the request host. A stale hidden digest
is rejected before posting a decision. Only the API's trusted approver resolver
can grant authority; the browser has no role field that can bypass it.

The requester can inspect their own draft but cannot approve it unless they also
have trusted approver authority. Approval state, expiry, and execution usage are
validated by the API/store. Pending expired approvals have no active decision
controls. An approval does not override source-system ACLs or revoked OAuth
credentials.

The read and write payloads are normalized once. Defaults such as `primary`
Calendar and bounded list limits participate in the digest. Object property
order does not change canonical hashes, while array order remains significant.

## Lost-response recovery

1. The approval store atomically claims the exact call and increments usage once.
2. The broker records an intent audit event containing the digest, without bodies.
3. The adapter creates with the stable idempotency key.
4. A timeout or retryable failure reuses the same key and payload.
5. The fake API returns its stored receipt if the first create already committed.
6. Completion stores the receipt and emits a safe completion audit event.

A completed replay is rejected. A new call ID or key cannot reuse the consumed
approval. An unfinished call can resume using its original binding. Fresh policy
and credential checks still run before recovery.
