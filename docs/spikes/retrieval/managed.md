# Gemini Enterprise managed-search arm (#109)

Date: 2026-10-13. Verdict: **DEFER/unavailable**. No Gemini Enterprise trial, connector configuration, service access or operator observation was supplied. Per ADR-0003, evaluation may proceed with arm B once it has real evidence. No managed-search live client or trial has been simulated, and no live PASS is committed.

`managed.json` records synthetic provenance, availability `unavailable`, verdict `DEFER`, no cases and null cost. Observed latency, recall, revocation lag, source ACL semantics, provenance validity, isolation, edition/region availability and service cost are all untested. `asia-northeast1` is the intended pilot region, not a verified service feature or residency assertion.

## Offline scope

`spikes/retrieval/managed/schema.mjs` validates synthetic service-shaped recordings for a narrowly defined document-search arm: result document ID, title, connector-normalized content/provenance, derived snippets and the answer surface. Extra response fields are preserved at every nested level, including result documents, structData, derivedStructData and snippet entries. Connector field names are normalization requirements for the harness; they do not claim every Gemini Enterprise connector emits these exact fields. A missing source URI/version/access reference fails validation rather than becoming an empty successful result.

`replay.mjs` normalizes those recordings into the same matrix-case schema used by Drive and the comparison tool. It preserves the entire sanitized response as `responseText` so answer, error and extension-field disclosures remain visible. HTTP denials cannot carry accepted hits. Negative fixtures cover Bob's title/snippet/content leaking into Alice's result, a generated answer, an extra field, a denial body, outsider, revoked group access and source deletion. Positive fixtures are synthetic replay tests, never service observations.

A service search identity must be established by verified identity-provider/source mappings. A `userInfo.userId` label alone is not assumed to grant or constrain document access. The operator must verify the exact source connector, ACL mode, identity provider, mappings, edition, feature stage and region before capturing observed evidence. The relevant primary references are [access controls](https://docs.cloud.google.com/gemini/enterprise/docs/identity) and [external identity mapping](https://docs.cloud.google.com/gemini/enterprise/docs/identity-mapping). Their availability does not prove the pilot tenancy has this feature.

## Run offline

From the repository root:

```sh
node --test spikes/retrieval/managed/replay.test.mjs
pnpm test apps/api/src/retrieval/drive-adapter.test.ts
node spikes/common/verify.mjs
```

The API test runs all spike suites through the existing Vitest gate, including `pnpm test` in CI. No shared runner or CI configuration is changed. `fixtures/offline.transcript.json` is a sealed #98 C-04 transcript with synthetic provenance and `defer/unavailable`; its evidence hash binds the corresponding empty arm report.

## Resume only with trial access

The operator must first confirm pilot tenancy access and the specific source connector/ACL behavior. If access remains unavailable, retain DEFER and stop this arm. If access becomes available, use the common corpus/query/expected access from `compare/matrix.mjs` with the real #21 identities, preserving canaries in every returned surface. Capture all six cases, raw sanitized response surfaces, original source provenance and deny outcomes. Map real users/object IDs/URIs to reviewed aliases outside git; do not erase an unexpected result while sanitizing.

Record measured latency, distinct-object recall, cost, membership-removal and deletion timestamps and repeated targeted denial samples. Record failed and stale access as evidence too. `compare/revocation.mjs` provides the deterministic sampled-lag summary; errors and empty unrelated queries cannot count as denials. Any observed cross-user or post-revoke disclosure is NO-GO. Bind the complete sanitized evidence to a real, uniquely named #98 observed transcript, and obtain owner approval of thresholds before selecting the arm. The repository has no managed-search live PASS pending that work.
