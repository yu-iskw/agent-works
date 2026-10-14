# Generation and drift

## Inputs and outputs

| File                                    | Responsibility                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/api-contract/operations.json` | Explicit route method/path and request/response binding                       |
| `scripts/schema-source.mjs`             | Converts existing domain schemas, selects discriminated request/response arms |
| `scripts/spec.mjs`                      | Emits OpenAPI 3.1 paths, parameters, security and JSON Schema components      |
| `scripts/client.mjs`                    | Derives typed operations from the emitted specification                       |
| `openapi.json`                          | Reviewable specification and route fingerprints                               |
| `src/client.generated.ts`               | Reviewable generated TypeScript client                                        |

Paths in this table are relative to `packages/api-contract` unless fully qualified. Generation reads `apps/api/src/routes` and `packages/domain/dist` without changing them. OAuth POST accepts both start and callback arms; DELETE returns the existing connection response. Task and approval discriminators are preserved exactly.

## Updating a contract

1. In a change authorized to edit routes/domain schemas, update the canonical runtime schema and route binding together.
2. Review the operation manifest when paths, headers or response arms change.
3. Run `pnpm api:generate` from the root; it builds domain schemas first.
4. Format the affected specification, generator and client with Prettier 3.9.6.
5. Run `pnpm build` and the API-contract tests.
6. Review the generated diff with its source changes.

`build` checks generation drift before compiling; it does not silently regenerate an outdated specification. A domain schema change alters generated JSON Schema. Route changes alter SHA-256 source fingerprints, including route additions and removals. A conservative fingerprint also detects implementation-only edits, so these require regeneration and review even when their wire shape is unchanged.

The client drift comparison uses a normalized TypeScript syntax tree. It ignores quote style, property-name quoting, redundant type parentheses and source formatting while retaining literal contents and types. It does not erase whitespace inside string literals. The regression suite checks meaningful literal/type changes and formatter equivalence.

## Validation scope

The spec validator checks the emitted OpenAPI 3.1 vocabulary, unique operation IDs, required path parameters and referenced request/response components. It compiles embedded JSON Schemas using the existing Zod JSON Schema converter. It is scoped to this generator's vocabulary rather than an arbitrary third-party OpenAPI document.

`operations.json` is a reviewed binding, not an automatic extraction of handler control flow. Fingerprints detect changes requiring review; they do not infer a new operation's semantic behavior. Authentication and policy remain runtime decisions.
