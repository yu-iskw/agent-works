# Connector trust boundaries

The HTTP route verifies IAP and derives `subject` from the verified assertion.
Strict request schemas reject additional identity, role, and scope fields. Tool
arguments cannot select a different OAuth subject.

The broker obtains a policy decision before resolving credentials. It refuses
unknown tools and Gmail send. Every tool uses the caller's Google connection;
there is no service-account fallback or process-global token. Stored and remote
connections must agree on subject, provider, token reference, active state, expiry,
and required scope. A missing scope returns `STEP_UP_REQUIRED`. A stale or revoked
connection emits `oauth.blocked` and stops execution before an approval is claimed.

The secret resolver accepts a token reference and the caller subject. That
resolver is a trusted deployment dependency; it must verify ownership and must
never log tokens. The broker never accepts a raw token in an HTTP request.

Google API endpoints use HTTP loopback addresses by default. The dev-stack
assembly explicitly allows the Compose `fake-workspace` hostname. Redirects are
rejected. Retries have a maximum attempt budget and bounded Retry-After delay.
Writes carry a stable idempotency key on every attempt. Terminal authentication
and ACL failures are not retried. Error responses expose mapped codes rather
than provider error bodies.

Fake Google bearer tokens resolve to server-owned subject and scope grants. Docs
uses destination ACLs, Calendar allows only the token subject or `primary`, and
Gmail serves `/users/me` only. Gmail draft thread references must belong to the
caller. Unknown body properties cannot override ownership. Fake idempotency
receipts are partitioned by subject and operation path and bound to a canonical
payload digest.

Calendar creation explicitly sends `sendUpdates=none`. The fake rejects any
other notification setting. This connector creates a Calendar record without
sending attendee email. Gmail creates drafts only and has no send adapter.

## Source handling

Calendar and Gmail reads validate response shape and classification before
returning data. Titles and bodies are wrapped using the governance `sourceData`
JSON contract: `kind=source-data`, `authority=none`, and an instruction that the
text must never be treated as instructions. Gmail results are at least
CONFIDENTIAL. A classification above the caller's authorized runner ceiling
rejects the whole result rather than silently dropping a sensitive row.

Meeting prep reads Calendar and caller-authorized Drive sources, validates the
Drive source wrappers, and passes only wrapped source data to its draft model.
The resulting Docs payload is persisted for human approval before any write.
Resuming with an approval reads the persisted payload and does not regenerate
model output or reinterpret source instructions.

## Persistence

Approval payloads and INTENDED/COMPLETED calls use the existing approval tables.
The broker records an audit intent before creating a remote object and persists
its receipt after completion. A retry of an unfinished call can recover through
the same idempotency key; a completed replay is denied. A retry never consumes a
second execution from the approval. An edited payload cannot recover an intent.
