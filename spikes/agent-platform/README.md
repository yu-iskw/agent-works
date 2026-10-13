# Bundle A: offline Agent Platform probes

These six independent probes implement issues #112, #105, #106, #107, #108 and
#111. Every adoption verdict is **UNVERIFIED / DEFER**. All committed fixture
content is **synthetic**; the `2000-01-01` capture timestamp is fabricated.
Nothing here asserts GA, Tokyo support, live IAM enforcement or measured cost.

| Directory          | Issue | Boundary                                                  |
| ------------------ | ----- | --------------------------------------------------------- |
| `agent-identity`   | #112  | Workload principal and separate per-user authority        |
| `runtime`          | #105  | Bounded runtime, session ownership, abort/restart         |
| `identity-gateway` | #106  | Registry, Gateway and direct-egress bypass                |
| `memory`           | #107  | Read-time ACL, user/agent ownership, deletion/retention   |
| `model`            | #108  | Approved region/model, endpoint failure, prompt redaction |
| `sandbox`          | #111  | Network, credentials, filesystem and execution limits     |

Agent Identity was built and tested first. Gateway imports its principal proof
and reads its sealed output; it does not edit Agent Identity. The proof's live
status stays UNVERIFIED and grants no implicit end-user authority.

Run from the repository root with the existing workspace dependencies installed:

```sh
node --test spikes/agent-platform spikes/common
node spikes/agent-platform/run.mjs
```

The runner needs no package or new dependency and creates no files. The shared
#98 verifier uses the repository's existing `zod` dependency and Node's TypeScript
support. Use a Node version that can load the shared TypeScript hash module.
No SDK, credential, cloud request, network fixture retrieval or untrusted program
execution is involved. Tests are an offline policy/recording check; the declared
backend `exchange(caseId, request)` returns sanitized scalar observations.

Each probe owns its `probe.mjs`, `evidence.mjs`, tests and fixtures. The small
validation wrappers remain local to respect exclusive issue ownership. They
import #98's sealer/verifier rather than defining a second transcript schema.
`fixtures/valid.json` is a sealed baseline. `scenarios.json` records negative
control inputs and explicit fake backend responses. `negative.json` contains
labelled mutation recipes that create invalid evidence from the valid baseline.
Malformed evidence is rejected; correctly denied challenges stay UNVERIFIED;
unsafe successes are NO-GO; missing capability/retention evidence is DEFER.

Checksums detect alteration, not dishonest provenance. Recomputed checksums are
also subjected to field, probe-binding, privacy and verdict consistency checks.
A forged but internally consistent recording cannot establish live validation.
The validators reject synthetic and observed GO claims in this offline bundle.
The runner reports intentionally unsafe synthetic cases separately and exits
successfully only when their expected NO-GO outcomes are preserved.

Operator runbooks and separate verdict JSON files are under
[`docs/spikes/agent-platform`](../../docs/spikes/agent-platform). Memory remains
disabled/deferred under RFC Phase 4. Sandbox thresholds and the model name are
synthetic policy examples, never product specifications or deployment defaults.
Production wiring and the #20 aggregate reports belong to other issues.

## Validation handoff

Bundle A was verified with offline Node tests, the replay runner and Prettier.
This worktree initially had no installed dependencies, so the shared verifier
could not resolve its existing `zod` import. Validation used a temporary Node
resolver reading `zod` from an already installed sibling checkout, and `npx`
used that checkout's existing Prettier in offline mode. No dependency file or
repository path outside the permitted probe directories was changed. A normal
workspace dependency installation is sufficient for subsequent runs.

Postmortem action: **no rule/hook/skill change**. The missing installation was
checkout setup, not a recurring harness defect. Keep synthetic observations
separate from live evidence, and preserve the #112 proof as a read-only Gateway
dependency. The live operator evidence fields remain unverified.
