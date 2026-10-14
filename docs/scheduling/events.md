# Verified events are still untrusted input

The ingestion endpoint authenticates the source before parsing the event body.
Signature verification alone does not authorize a task, widen a ceiling, create
consent, change the pinned skill or bypass suspension/budget admission.
The resulting task always uses the exact pinned schedule task template.
The event payload is retained separately as `trust: untrusted` evidence and is
never merged into task input, objective, principal, scopes or policy facts.

## Envelope headers

| Header              | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `x-aw-trigger-id`   | Registered trigger UUID                            |
| `x-aw-event-source` | Exact registered source                            |
| `x-aw-event-id`     | Source event ID for permanent dedupe               |
| `x-aw-event-time`   | Canonical UTC ISO timestamp including milliseconds |
| `x-aw-key-id`       | Exact registered signing key ID                    |
| `x-aw-signature`    | Lowercase hex HMAC or compact JWS                  |

The signed bytes are UTF-8 metadata followed by the exact raw JSON body:

```text
aw-event-v1\n<trigger UUID>\n<source>\n<event ID>\n<timestamp>\n<key ID>\n<raw body bytes>
```

Each `\n` above denotes one LF byte. Every metadata field is bounded to 256
characters and cannot contain CR or LF. The trigger UUID is signed to prevent
retargeting an envelope to another registered trigger using the same source
and key. Changing raw JSON whitespace or key ordering changes the signature.

HS256 computes HMAC-SHA256 over these bytes and accepts exactly 64 lowercase
hex characters. Verification compares equal-sized buffers in constant time.
RS256 and EdDSA accept a compact JWS whose decoded payload is exactly the same
signed bytes. The protected header binds `alg` and `kid`; only RS256 with an RSA
public key or EdDSA with an Ed25519 public key is accepted. Unknown headers,
critical extensions, detached payloads, noncanonical base64url, extra compact
segments and `alg: none` are rejected. Algorithms cannot be substituted across
registry entries. Keys are bound to one source and can be revoked.

## Replay and schema checks

After verifying the signature, ingestion requires a canonical timestamp no
later than the current clock and no older than the registered replay window.
The allowed window is 1–3,600 seconds and the default fixture uses 300 seconds.
The boundary is inclusive; even a one-millisecond future event is rejected.

The offline payload schema is a deliberately bounded object contract with
string, number and boolean fields, explicit required flags, optional string
length limits and `additionalProperties: false`. No coercion occurs. Arrays,
null, objects inside fields, unsupported schemas and unknown fields fail.
The raw body is limited to 16 KiB. The event cannot supply a schema or key.

A unique `(source, source_event_id)` database constraint permanently rejects a
second receipt, including across restart and across trigger registrations.
A digest binds the authenticated metadata and parsed payload. Claim and receipt
are committed atomically, so two concurrent deliveries produce one run.
A dispatch outage retains the receipt and lease for scheduler recovery; a retry
webhook is rejected rather than interpreted as new work.

## Adversarial examples

A payload with `scopes: [admin.all]` is rejected when scopes is not in the pinned
payload schema. Even if an operator deliberately defines `scopes` as a string
field for an integration, its contents remain untrusted evidence: they do not
become task scopes. The same applies to a text field requesting a different
skill, new consent, unrestricted sources or system-prompt overrides.

Verified events still require an active schedule, a live sponsor, current
ceiling containment, valid consent, published capabilities, no applicable
suspension and budget admission. A denial is recorded as a denied run; its
source-event identity remains consumed. The integration must deliver a new
source event ID to request a distinct action after conditions change.

## Session learnings

The budget port intentionally throws on release of an unknown operation.
Authority and suspension denials precede reservation, so cleanup must release
only a known charged operation. Shared contract tests also make database
unavailability explicit: a memory fallback would falsely imply the Postgres
contract had run. No shared agent configuration change is needed for these
feature-specific findings; the tests preserve the lesson.
