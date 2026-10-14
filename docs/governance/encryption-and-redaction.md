# Encryption and redaction boundaries

## Artifact envelopes

The `KeyProvider` port wraps and unwraps data keys. Each artifact or registered
derived payload gets a new random 256-bit data key and a new 96-bit AES-GCM nonce.
Plaintext is encrypted with AES-256-GCM; its data key is separately wrapped by the
provider with its own nonce and authentication tag.

Stored envelopes include an algorithm/version, key identity, wrapped data key,
wrapping nonce and tag, payload nonce and tag, ciphertext and an AAD digest.
They contain no raw data key or key-encryption key. Buffers holding temporary data
keys are zeroed in `finally` blocks on both success and failure.

JavaScript strings and cryptographic library internals cannot be reliably wiped
by this helper. This is a local envelope implementation, not a claim of hardened
process memory or hardware-backed key protection.

The artifact's authenticated context covers identity, task, kind, provenance,
classification, creation, expiry, retention policy and canonical content hash.
The mutable `legalHold` summary is excluded so legal releases do not require
re-encrypting bytes. The store derives that summary from trusted hold commands.
Derived payload contexts bind the parent identity, derived identity and kind.

Changing ciphertext, nonce, tag, key wrapping, provenance or classification
invalidates authentication. Decryption also verifies the plaintext canonical hash.
A malformed envelope, missing key, wrong provider, mismatched context or failed
authentication produces the controlled `KeyUnavailable` error. Ciphertext is
never returned as a plaintext fallback.

## Local KMS lifecycle

`createLocalKms(keyId)` is an explicit in-process fake. It generates random
key-encryption material, supports rotation and retains old versions until they
are revoked. Rotation changes only the active wrapping version; old artifacts
remain readable through their original version.

Revocation overwrites and removes the corresponding key buffer. That identity
cannot be reused in the same provider. Artifacts encrypted with other active key
versions continue to decrypt. Two providers with the same key identity still
have different random material, so cross-provider reads fail.

A process restart loses this fake's keys. Do not use it as a durable production
key service or imply that restoring the database restores the keys. Applications
must keep their local fake alive for the required test lifetime.

`createCloudKmsStub(enabled)` is a typed, feature-gated placeholder. A disabled
flag rejects creation. An enabled flag still rejects wrapping and unwrapping;
it does not contact Cloud KMS or report fake success. Cloud resource identity,
residency, IAM, key recovery and revocation evidence remain future integration
work.

## Read authorization

The governed artifact route verifies IAP before obtaining a read context. The
trusted context must identify that same caller. The store checks ownership,
classification ceiling, allowed region, allowed origin, current ACL evidence,
expiry, source revocation and deletion-request fences before it unwraps a key.

Denied or missing artifacts return 404. A context for the wrong caller returns 403. Key availability failures return a controlled 503 without source text,
internal cryptographic errors or the encrypted envelope. Responses from the
composed HTTP runtime have `cache-control: no-store`.

A legal hold is a preservation control. It grants neither ownership nor permission
to read an expired or revoked record. Any future legal-discovery read capability
requires its own explicit authorization boundary.

## Task event and SIEM projection

`redactClassifiedPayload` accepts a trusted root classification and untrusted
payload. A RESTRICTED root becomes the single string `[RESTRICTED]`, including
all nested keys. A nested object explicitly marked RESTRICTED also becomes that
single marker. Invalid explicit nested classification labels fail closed to the
same marker. A nested PUBLIC label cannot downgrade a RESTRICTED root.

Arrays recurse through the same boundary. Prototype mutation keys are omitted.
Nested data beyond the depth bound becomes `[DEPTH-LIMIT]`. Classification is a
trusted producer decision; the redactor cannot infer confidential data from
unlabelled text. Producers must set the correct root or field classification.

`classifiedTaskEvent` applies this projection before returning a task event.
`exportGovernanceMarkers` exports allowlisted audit markers only. Governance SIEM
markers contain hashed event identity, type, clock, actor/target digests, a hashed
request reference, state and the tombstone marker. Raw request subjects, case
references and payloads are absent from that projection.

The marker exporter is at-least-once: retrying can resend existing events. A SIEM
sink should deduplicate by `event_id` and commit its own delivery cursor. Sink
failure rejects the export operation. The helper does not rewrite or erase a
previously delivered external event.

The golden fixture at
`apps/api/src/governance/fixtures/redaction-golden.json` is exercised against both
the redactor and task-event projection. Tests also cover restricted keys, malformed
labels, nested arrays, depth limits and prototype pollution attempts.

## Retrieved source data

The ADK and scripted runner adapters wrap retrieved `text` with a JSON source-data
contract when constructing the prompt, before it reaches the model. Caller-bound
retrieval results and the runner input contract retain their original text and
citation shape. The wrapper labels its kind, contract version, lack of authority
and an explicit instruction to treat the enclosed text as untrusted data. JSON escaping prevents retrieved text from
closing the envelope and inserting a different authority field.

This boundary does not authorize extra tools or promote document instructions.
The adversarial fixture includes plain, HTML, Unicode and encoded prompt-like
text, including “ignore previous instructions”. Caller binding remains ahead of
retrieval and wrapping. The wrapper complements the existing runner/tool policy;
it is not a complete prompt-injection defense on its own.
