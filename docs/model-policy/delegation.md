# Explicit delegation context

`createDelegator` is enabled only when its injected flag equals the exact string `enabled`. Omitted, empty and malformed values disable it. A disabled spawn records denial evidence and cannot reach execution, verification, budget reservation or edge creation.

The parent context binds task/root/parent IDs, trace, depth, authority, budget scope and allocated share. Authority binds subject, agent principal, region, governance zone, expiry and a policy decision reference. Grants are exact capability/resource pairs; independent capability/resource sets would allow unsafe combinations.

A request proposes child task ID, requested grants and budget share. `childContext` validates the trusted parent, rejects expired authority, enforces the configured maximum depth and retains root identity, trace and budget subject. It computes the child's grants by intersecting the parent's exact pairs with the requested pairs. Models cannot supply the resulting authority object or alter identity, geography, expiry or policy reference. A 1,000-run property test checks arbitrary grant requests.

Shares cannot enlarge the parent's cost, step or concurrency allocation. Execution uses the existing #137 budget guard with the parent's root task/user scope and a child-specific operation ID. Multiple children therefore accumulate spend and steps in the same envelope. Completion releases concurrency only; rejected verification and failed execution do not erase incurred spend. Observe mode retains the pilot policy; isolated enforcement is available for contract tests.

## Independent verification

The child executor and verifier are separate injected roles. After execution, the orchestrator clones output and computes its digest. It calls the verifier and returns output only after the persistence port records `verified` with both digest and nonempty verifier reference. Exceptions or a negative result persist rejection and audit evidence; parent consumption remains unreachable.

The offline `citationVerifier` implements a strict extractive policy. Cited sources must be trusted, unique and covered by the computed `drive.read` grants. The answer must exactly match the cited source text with source labels, within the output bound. It rejects appended unsupported assertions and known sources outside the child grant. A future synthesis verifier needs independently measured grounding coverage; this fixture verifier makes no such claim.

Execution errors settle the edge as failed. A persisted terminal child cannot be reexecuted after reconstruction, and concurrent duplicate child IDs are rejected by the orchestrator. Ports reject identity conflicts and terminal outcome rewrites.
