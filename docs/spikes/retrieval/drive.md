# Caller-delegated Drive retrieval (#110)

Date: 2026-10-13. Verdict: **UNVERIFIED; live validation deferred**. No cloud request was executed for this implementation. The JSON report has synthetic provenance and null cost; there are no observed latency, recall, revocation-lag or isolation measurements. `asia-northeast1` is the intended pilot region from ADR-0003, not a measured Drive storage or processing location.

## Implemented scope

`apps/api/src/retrieval/drive-adapter.ts` exports a standalone `createDriveAdapter(options): SearchPort`. It does not select a server route, change a retrieval interface, build an index or use application default credentials. Search uses Drive v3 `files.list`, `files.get` and Google Docs `files.export` to plain text. Plain text blob files use `alt=media`. Other file types, including Sheets, Slides, shortcuts and PDFs, are omitted. Recall measurements must describe this limited feature scope.

Listing requests only file IDs; titles are read after a caller-scoped metadata request. Content is read with the same credential, then metadata is read again. A 403, 404, trashed file, download prohibition or changed version/name/type omits the whole result. Title, excerpt and content are released together. A credential failure, malformed response, policy outage, network failure, incomplete search, cyclic pagination or exhausted limit fails the search, including any partial hits. Redirects are refused and content/listing bytes, pages, query length and result count are bounded. Every search resolves its own credential; results and permission decisions are never cached.

The adapter returns original object ID, constructed Drive URI, Drive version in `etag`, retrieval timestamp, excerpt and a subject/object/version-bound access decision reference. That reference is local provenance; it is not a Google permission-decision receipt. A 404 is recorded as `not-found-or-denied` because Drive can hide an inaccessible file as missing. Source access events contain only an object ID and decision, never upstream error bodies, document surfaces or credentials.

## Trusted identity and policy boundary

The input `Caller` must come from the repository's authenticated verifier. `credentialFor(caller)` is a trusted server integration with the existing OAuth grant store, not a request-body deserializer. It must attest an actual user-consented OAuth grant, validate its identity binding and provide its current expiry. The adapter requires `kind: user-delegated`, `identityVerified: true`, `domainWideDelegation: false`, matching immutable caller/Google subjects and the Drive read-only scope. Missing, expired, malformed, service-account, blanket, impersonated and mismatched credentials are rejected before a Drive request. Refresh/revoke state belongs to the trusted store; the adapter never refreshes through a service identity.

Google access tokens are opaque. Flags on a self-supplied object cannot prove consent or token ownership. Do not expose the provider callback to clients or manufacture a verified caller with a cast in a live integration. If the IAP verifier and OAuth identity provider use different subject namespaces, the integration must establish their verified canonical binding before calling this standalone adapter. This bundle does not modify either identity contract.

`policyFor(file)` must consult a trusted source inventory for tenant, classification and approved region. Unknown inventory denies the file; an outage fails closed. Drive's global API endpoint does not establish Tokyo residency. Group strings in SearchContext never override source ACLs. Source permission enforcement comes from the caller's actual delegated token. Metadata is checked before and after the read; the source API has no atomic read-and-revoke transaction, so the live revocation matrix remains required.

Drive's documented media/export split and download capability are the basis for this limited implementation: [files.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get), [download and export](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [file version and capabilities](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).

## Offline evidence and checks

`spikes/retrieval/drive/fixtures/*.json` contains service-shaped **synthetic recordings**, including Alice, Bob, shared group, outsider, revoked member and deletion, plus denial at metadata/content/post-read checks, version changes, malformed metadata, expiry and server failure. The fake strings `FAKE_REDACTED_DELEGATED` and `FAKE_REDACTED_IAP` are not credentials. No fixture records a successful live request. `schema.ts` validates recordings and enforces transport order. The API test runs every recorded exchange through the actual adapter.

`fixtures/evidence.json` and `docs/spikes/retrieval/drive.json` contain the same sealed, empty live-evidence report. `fixtures/offline.transcript.json` uses #98's unchanged C-04 contract with `unverified`, synthetic provenance, explicit omissions and an evidence SHA-256 observation. A green transcript verifier is a format/integrity result, not ACL proof.

From the repository root:

```sh
pnpm build
pnpm test apps/api/src/retrieval/drive-adapter.test.ts
node --test spikes/retrieval/drive/replay.test.mjs
pnpm exec tsc --noEmit -p spikes/retrieval/compare/tsconfig.json
node spikes/common/verify.mjs
```

The API test includes a Node test bridge for all three spike suites. Existing `pnpm test` therefore runs them without editing Vitest or CI. The standalone suites use the same Node test tool as `spikes/common`. The project pins Node 24.13.0, which supports TypeScript stripping; the live probe imports the built API module to honor its NodeNext `.js` imports.

## Operator live runs

No operator module, OAuth grant or live tenant was available here. To produce evidence:

1. Finish #21 with real pilot identities; retain the private canonical-subject and corpus-object alias maps outside git. Create the four test corpus documents and the reviewer group from `compare/matrix.ts`. Each document must contain its title/snippet/content canaries and the common query phrase. Alice belongs to reviewers; Bob does not. Reviewer is a group member; outsider can read only the intentionally public document.
2. Implement an operator-local module exporting `options`, `context`, `caseId` and `bindings` for `probe.ts`. `options` must use the real verified Caller, trusted OAuth grant store and source inventory. `bindings` contains verified `callerSubject`, its `subjectAlias`, and real-object-ID to corpus-alias `sourceAliases`. The runner rejects identity mismatches and unmapped objects, and sanitizes IDs/URIs while preserving canaries. Keep the private URI/version mapping for provenance review.
3. Run `pnpm build`, then `node spikes/retrieval/drive/probe.ts --operator-module /absolute/private/probe-config.ts`. This performs real reads only when explicitly run by the operator. Standard output is a case observation, not a GO report. No token or source error body is printed; source content must be the synthetic pilot corpus. Review output before saving it. Never use customer documents as fixtures.
4. Repeat the exact query for all six cases. Remove reviewer membership, record the authoritative source change time, and use `pollRevocation` with a real targeted access recheck. An empty search or a transport failure is not proof of denial. Repeat for source deletion. Preserve all samples and the polling interval, including stale allows; keep at least two consecutive denials. Sampling produces an upper bound, not an exact propagation instant. Any returned forbidden surface or stale access disqualifies the arm.
5. Normalize cases using `compare/schema.ts`, record exact service feature scope/configuration, observed latency and cost, and bind the sanitized payload to a sealed C-04 transcript using `bindEvidence`. Operator capture timestamps are real capture times, not this fixture date. The checksum binds content; it does not authenticate the cloud or replace operator review. Do not use the fixture helper's `offline` ID for a real capture; supply a unique C-04 run ID and stage in a reviewed transcript.
6. Replay comparison after source ACL/provenance review and owner approval of the proposed thresholds. No live selection is justified by this bundle alone.
