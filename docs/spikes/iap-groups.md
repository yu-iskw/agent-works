# IAP sign-in and group mapping offline spike (#21, C-03)

Verdict: **DEFER**. Live proof is not possible at this stage:
no IAP-protected service is deployed because the #24 live deploy is on hold
by Yu's decision. Furthermore, the sandbox IAP allowlist is currently restricted to
`user:yu.ishikawa@dr-ubie.com`, so multi-identity evaluation (Alice, Bob, outsider)
cannot be exercised in cloud infrastructure.

## Evidence summary

### Observed on 2026-10-15 (operator fetch from the Mac)

The operator executed an out-of-band HTTPS fetch from their workstation to Google's public JWKS endpoint:

- **URL**: `https://www.gstatic.com/iap/verify/public_key-jwk`
- **HTTP status**: `200 OK`
- **Response headers**: `cache-control: public, max-age=3000`
- **Key count**: 5 keys returned in JSON Web Key Set format
- **Key geometry**: All 5 keys have `kty: "EC"`, `crv: "P-256"`, `alg: "ES256"`, with standard coordinates (`x`, `y`) and key identifier (`kid`)
- **Key identifiers (`kid`)**: Not recorded

### Unverified live items

The following aspects cannot be validated offline and remain **UNVERIFIED**:

1. **IAP sign-in on Cloud Run**: Direct-IAP assertion injection via `x-goog-iap-jwt-assertion` header on Cloud Run service requests.
2. **Outsider 403**: Google IAP front-door rejection of unauthenticated or unauthorized callers before reaching Cloud Run.
3. **Group mapping**: Propagation and extraction of Workspace group memberships through directory snapshot lookup.
4. **Bob removal / revocation lag**: The actual wall-clock duration between dropping Bob from the tenant group and Bob's subsequent denial across Cloud Run and downstream API layers. This must be measured when a second user and a deployed service exist.
5. **JWKS outage behaviour on the live path**: Runtime resiliency and error handling when Google's JWKS endpoint experiences an outage or network partitions under live load.

## Direct-IAP Cloud Run audience contract

For direct-IAP integration with Cloud Run services, Google IAP signs assertions with:

- **Issuer**: `https://cloud.google.com/iap`
- **Audience format**: `/projects/<projectNumber>/locations/<region>/services/<serviceName>`

Per [ADR 0003](../adr/0003-pilot-decisions.md), the required pilot region is `asia-northeast1`.
The implementation in `apps/api/src/auth/google-jwks.ts` validates these parameters and fails closed on invalid inputs (non-digit project number, non-Tokyo region, or invalid Cloud Run service names).

## Proposed security budget for revocation lag

The following values are **proposals for the C-05/IAM owner**, not measured values or accepted SLOs:

- **Maximum revocation lag proposal**: `<= 60,000 ms` (60 seconds).
- **Target owner**: C-05/IAM owner.
- **Rationale**: When a user is removed from a Google Workspace role group (e.g. `bob` removed from `agent-users`), directory cache/snapshot TTL and verification windows should converge to revocation within 60 seconds. This proposed budget aligns with the proposed threshold in `retrieval-acl.json`.
- **Status**: Proposal only (`status: proposal`, `approvedBy: null`). Keeping wording strictly honest: no live lag measurement exists.

## Offline verification and test coverage

The offline unit test suite in `apps/api/src/auth/google-jwks.test.ts` exercises:

- Configuration generation and input validation (fail-closed on non-digits, non-`asia-northeast1` region, or invalid service name).
- End-to-end assertion verification with `createIapVerifier`:
  - Valid JWT accepted with Google issuer and direct-IAP audience.
  - Bad audience rejection (`bad_claims`).
  - Bad issuer rejection (`bad_claims`).
  - Missing and empty assertion rejection (`missing`).
  - Forged assertion rejection (`bad_signature`).
  - Expired assertion rejection (`expired`).
  - Key rotation (new `kid` appearing after the 5 s refetch window).
  - Outage handling: JWKS fetch failure produces `Unavailable` and fails closed.
  - Parsing of realistic Google-shaped JWKS (5 EC P-256 keys with extra fields such as `alg` and `use`).
- Stale group membership note: group membership revocation is handled downstream by `directory.ts` / role resolver, not by the cryptographic assertion verifier.
