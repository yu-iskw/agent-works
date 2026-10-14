# Validation composition

`withRequestValidation(operationId, next)` is an opt-in request adapter. It parses JSON, verifies mandatory headers case-insensitively and validates the selected request schema before calling `next`. Invalid JSON, unknown fields, absent required headers and invalid discriminators receive `{ status: 400, body: { error: "invalid_request" } }` without dispatch.

Compose it after authentication on an already matched operation so that validation does not reorder authentication, reveal resources or change existing policy behavior. Issue #141 does not alter route handlers or wire new middleware into their default execution paths.

The typed transport applies the same request-body and operation-header validation. It validates successful JSON responses against the status-specific component. The generated schema vocabulary includes objects, required properties, closed/additional properties, property-name schemas, arrays, bounds, enums, literals, unions, finite numbers, numeric exclusive limits and string patterns/formats. Recursive `JsonValue` is supported for domain JSON payloads. Unknown reference targets fail closed.

The validator consumes trusted generated schemas. Request input cannot supply a regex or a schema. It is intentionally bounded to the schema vocabulary emitted here; introducing new schema keywords requires extending validation and adding parity tests.

The OpenAPI security scheme documents `x-goog-iap-jwt-assertion`. Presence of that header does not prove authentication; the existing signed assertion verifier remains authoritative. CSRF validation in the adapter verifies a nonempty operation header; binding and validity remain the existing approval route's responsibility.

Tests cover injected identity/scopes, invalid JSON, missing idempotency and CSRF headers, malformed digests, positive deadlines, URI formats, response drift and generated CLI transport. TypeScript checks the generated types; runtime validation checks untrusted JSON.
