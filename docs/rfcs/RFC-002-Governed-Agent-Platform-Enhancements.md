---
title: "RFC-002: Governed Agent Platform Enhancements"
status: "Proposed — architecture and security review required"
version: "0.1-draft"
date: "2026-10-25"
supersedes: []
related:
  - "RFC-001: Internal Enterprise Agent Platform"
  - "ADR-0001: TypeScript-first with ADK JS"
  - "ADR-0003: Pilot decisions"
  - "ADR-0004: Application core and adapter boundaries (Proposed)"
classification: "Public architecture proposal; no deployment authorization"
---

# RFC-002: Governed Agent Platform Enhancements

**Status:** PROPOSED / DISCUSSION ONLY

**Decision requested:** Agree on the next architecture and verification priorities for agent-works: consolidate existing framework-neutral boundaries, make canonical authority authoritative at effect execution, qualify the current pilot end to end, and evolve durable verification and observability selectively. This RFC does **not** authorize cloud deployment, new credentials, production autonomy, security-policy exceptions, or feature activation.

**Relationship to existing decisions:** This RFC extends [RFC-001](RFC-001-Enterprise-Gemini-Style-Agent-Platform.md) and the [architecture boundaries proposal](../adr/0004-application-core-and-adapter-boundaries.md). It does not supersede [ADR-0001](../adr/0001-typescript-first-with-adk-js.md), [ADR-0002](../adr/0002-monorepo-layout.md), or accepted [ADR-0003](../adr/0003-pilot-decisions.md). Where a recommendation conflicts with an accepted ADR or an operator-only cloud gate, the accepted decision and gate prevail until separately amended.

**Evidence baseline:** Read-only inspection of the public repository at main commit 07f718ca55ac57a8e36bad863b47e18c5cc11b5c and its documentation/issues, compared with public architectural material in the [AgentWorkforce organization](https://github.com/AgentWorkforce). The architecture comparisons are inspiration, **not** a claim that Agent Relay Cloud has been independently tested, is entirely open source, or should be adopted as a runtime dependency. No local tests, real GCP deployment, authenticated hosted-service tests, performance benchmark, security review or production certification were executed as part of this RFC.

---

## 1. Summary and recommendation

agent-works should remain a **Google Cloud/Workspace-oriented, TypeScript-first, governed enterprise agent workbench**, not grow into a clone of Agent Relay's hosted communication and collaboration product.

Its existing foundations include policy-aware request handling, a PostgreSQL task ledger and outbox, leases/fencing, human approvals, connector-specific OAuth and authorization, local workflow checkpoints, Cloud Workflows integration surfaces, signed event intake, delegated authority, memory governance, and adversarial tests. The implementation is still a **pilot**: the README states that offline fakes work while real dev deployment and managed-service qualification are pending.

The recommended changes are deliberately incremental:

1. **P0 — enforce trust boundaries and finish evidence gates.** Resolve canonical execution authority and make meaningful two-user isolation tests possible; continue operator-controlled cloud qualifications.
2. **P1 — consolidate existing interfaces.** Make the agent runner framework-neutral, isolate application use cases from HTTP, clarify contract ownership, and enforce dependency rules.
3. **P2 — improve durable correctness.** Pin executable workflow definitions where recovery requires it; make verification and external-effect reconciliation explicit; correlate execution evidence without collecting unnecessary sensitive content.
4. **P3 — experiment with collaboration only if needed.** Evaluate a bounded inbox and session/handoff contracts against the existing task/event primitives before introducing another messaging system.

**Architecture principle:** Agent decisions may propose work; only the trusted application control plane authorizes and records effects.

### 1.1 What this RFC does not change

- The accepted **asia-northeast1** pilot region and the separate managed-service evidence requirements.
- The accepted **observe-only spending** posture in the dev project: no new hard spend cap, billing disablement, or budget-triggered stop is authorized.
- The accepted first real write target: **a Google Docs draft in a shared drive**; the fake ticket tool remains useful for CI.
- Human-operator ownership of Terraform applies, IAM changes, Cloud Run deployment and real-cloud tests.
- The current choice of **TypeScript**, **Google ADK behind a port**, **PostgreSQL**, **Cloud Workflows** and a **modular monolith**.
- Existing explicit feature flags and fail-closed behavior for managed services, connectors, delegation and memory.

## 2. Problem and motivation

The monorepo has already implemented many of the right reliability and security primitives. The more immediate risks are **inconsistent execution boundaries, unverified end-to-end behavior, and premature infrastructure expansion**, not lack of a chat transport or a new orchestration language.

Specific observed seams:

| Area | Evidence in this repository | Gap / next validation |
| --- | --- | --- |
| Broker authority | Domain Authority and ToolCall schemas exist; the broker separately accepts actorSub and PolicyFacts | Ensure server-derived, current authority is authoritative for every side effect; see [#169](https://github.com/yu-iskw/agent-works/issues/169) |
| Agent execution | AgentRunner contract, ADK adapter and scripted adapter exist; limits are defined in another port | One unambiguous framework-neutral boundary, normalized cancellation/errors, tool calls only through the governed broker; see [#167](https://github.com/yu-iskw/agent-works/issues/167) |
| Application orchestration | Ask route handles retrieval, runner, persistence and audit orchestration alongside HTTP concerns | Isolate the ask use case without broad package movement; see [#168](https://github.com/yu-iskw/agent-works/issues/168) |
| Contract ownership | Domain exports coexist with generated OpenAPI/API contract | Classify domain vs transport schemas, preserve serialized compatibility; see [#170](https://github.com/yu-iskw/agent-works/issues/170) |
| Architecture regression | Proposed dependency rules exist, but do not yet have the targeted fitness check | Enforce forbidden imports and cycles in CI; see [#171](https://github.com/yu-iskw/agent-works/issues/171) |
| Real cross-user isolation | Offline checks exist; web lacks an owner-readable record for a positive-control test | Complete [#161](https://github.com/yu-iskw/agent-works/issues/161), then collect real [#24](https://github.com/yu-iskw/agent-works/issues/24) evidence |
| Durable workflow | Local engine, checkpoint/receipt ports and Cloud Workflows adapter exist | Verify immutable plan identity, crash windows, cancellation and uncertain external writes before adding more workflow machinery |
| Collaboration | Tasks, scheduled runs, signed events and delegated child tasks already coordinate work | First prove that an additional inbox solves a concrete unmet use case |

The distinction matters: **message delivery, model execution, workflow completion and external-effect commitment are separate events**. No single event implies all the others.

## 3. Goals, non-goals and success criteria

### 3.1 Goals

| ID | Requirement | Evidence / exit condition |
| --- | --- | --- |
| G-01 | One trusted authority decision path for model- or workflow-requested tools | Forged actor/policy facts, expiry, revocation, parent-child scope escalation and approval mismatch fail closed |
| G-02 | One framework-neutral AgentRunner execution contract | Scripted and ADK adapters satisfy identical tests without leaking ADK types into domain/application/public APIs |
| G-03 | Framework-neutral application use cases | Ask flow tested against ports without HTTP server, ADK or database driver |
| G-04 | Stable public and persisted contracts | Existing routes, error envelopes, task state, audit semantics, idempotency and stored event versions continue to work |
| G-05 | Proven caller isolation in a deployed pilot | Owner can read a canary-bearing record and a second authenticated user cannot read it at the identical URL |
| G-06 | Honest, recoverable workflow outcomes | Injected crashes and uncertain provider receipts cannot be silently promoted to success |
| G-07 | Inspectable, privacy-safe execution evidence | A task and its child runs, policy decisions, approvals, tool receipts and verifiers can be correlated by stable IDs |
| G-08 | Low operational overhead | No new mandatory broker cluster, message store, programming language or always-on service for the initial pilot |

### 3.2 Non-goals

- Reimplementing Relaycast, Relayfile, Relayauth, the Agent Relay Cloud control plane, or its desktop app.
- Building general-purpose peer-to-peer agent chat or a new distributed messaging engine.
- Replacing Cloud Workflows with a homegrown workflow scheduler or importing the Agent Relay Rust kernel.
- Migrating the monolith to microservices or promising multi-cloud portability.
- Introducing a generic writable SaaS virtual filesystem or new OAuth authority model.
- Broadening production Google Workspace scopes or enabling Gmail send.
- Enabling full autonomy, agent marketplaces, multi-agent delegation or cloud sandboxes by virtue of this document.
- Refactoring every module for visual consistency or increasing the package count as a target.

## 4. Proposed logical architecture

The following are **logical responsibilities**, not required independent processes or packages:

~~~text
Experience
  Web / aw CLI / generated API client
        |
        v
Control plane (modular monolith; apps/api composition)
  Verified IAP identity -> application use cases
  -> canonical authority + policy + approvals + budget posture
  -> task ledger / outbox / scheduling / audit / governance
        |
        v
Execution adapters (replaceable)
  AgentRunner -> Google ADK, scripted fake
  WorkflowPort -> local engine, Cloud Workflows adapter
  ToolBroker -> typed Google Workspace provider adapters
        |
        v
External systems
  Approved model endpoint / Google APIs / GCP services

Durable records: task transitions, dispatch leases and fencing, step
checkpoints, effect intent, external receipts, verification evidence.
Optional future: agent inbox / handoffs, not in the initial critical path.
~~~

The existing domain and policy packages own business invariants. Application use cases depend on ports. Concrete providers implement ports. The HTTP layer authenticates and translates transport; it does not secretly become the policy authority. **A runtime callback is never an authorization boundary.**

This reinforces ADR-0004; that ADR remains Proposed until its own validation requirements are met.

## 5. Decision proposals

| Decision | Recommendation | Priority | Counterargument / gate |
| --- | --- | --- | --- |
| D-01 | Canonical Authority is derived/verified from trusted state at broker execution | P0 | Keep the current domain Authority; do not add parallel self-asserted authority types |
| D-02 | Keep a single minimal AgentRunner interface; separate optional session/streaming capability contracts later | P1 | Avoid premature generalized PTY, sandbox or chat session abstractions |
| D-03 | Extract representative ask orchestration only; use architecture fitness checks | P1 | No broad folder move or new package until measurable value |
| D-04 | Retain PostgreSQL as business state and Cloud Workflows as optional managed progression | P2 | Deployment and managed-service suitability still require operator evidence |
| D-05 | Consider immutable, content-addressed executable workflow definitions only where recovery/reproducibility needs them | P2 | Do not redesign every already working workflow interface |
| D-06 | Add explicit verification and reconciled effect outcomes, not an unsupported exactly-once guarantee | P2 | External providers may lack full idempotency/read-back APIs |
| D-07 | Correlate audit and observability, while maintaining distinct data-retention/privilege rules | P2 | Detailed LLM prompts or retrieved data must not enter telemetry by default |
| D-08 | Defer durable agent inbox and standardized handoffs pending a use-case spike | P3 | First compare task events, existing delegation and workflow signals |
| D-09 | Keep typed Google connectors authoritative for writes; read-only resource projections are optional | P3 | Writable VFS semantics complicate concurrency, approval and authorization |

## 6. Core design requirements

### 6.1 Identity, authority and effect execution (P0)

**Invariant A1:** the authenticated human, workload agent identity and sponsor/delegated authority are distinct. A model/client cannot establish any of them by emitting fields.

**Invariant A2:** all agent-requested and deterministic-workflow-requested tool effects cross the **same trusted authorization and broker path**. An ADK function call, webhook signature, chat message, workflow callback or retrieved document never substitutes for a current authorization decision.

**Invariant A3:** current policy, capability scope, resource, approval payload digest, identity state and required source ACLs are revalidated at effect time and on retry/resume as appropriate. Revocation fails closed; service outages cannot silently grant access.

**Invariant A4:** delegated authority is never broader than the parent in any capability/resource pair, expiry, geography, classification or budget dimension. Use existing attenuated context and shared-budget semantics rather than inventing another model.

**Invariant A5:** a broker records intent and reconciles external effects using stable keys and receipts. A process-local Set is not a durability guarantee. A post-side-effect/pre-receipt crash may leave an **unknown** outcome requiring reconciliation or review, especially for risky writes.

**P0 work:** [#169](https://github.com/yu-iskw/agent-works/issues/169), together with [#161](https://github.com/yu-iskw/agent-works/issues/161) and the independent managed-identity probe [#112](https://github.com/yu-iskw/agent-works/issues/112). Do not widen their owned file scopes through this RFC.

### 6.2 AgentRunner and application boundaries (P1)

**AgentRunner:** retain a simple request/response operation for current ask behavior. Normalize deadline/cancellation, bounded steps and retries, typed failure outcomes, model-call admission, and tool-call interception. ADK and fakes satisfy the same contract; ADK-specific sessions, events or SDK classes stay inside the adapter. Make sure all routing/suspension guards execute at the appropriate model-call boundary, including after retry.

**Application orchestration:** move the minimum useful ask orchestration to an independently testable use case in apps/api, leaving request verification and HTTP status translation in routes. Avoid a new package absent concrete dependency evidence.

**Contract ownership:** business invariants and durable state belong to domain; HTTP/OpenAPI schemas and error presentation belong to api-contract; event-contract extraction remains conditional on independently versioned consumers.

**Dependency fitness:** CI should reject imports of ADK, HTTP implementation and database drivers from framework-neutral use cases, plus forbidden domain/policy edges and cycles. Document narrow existing exceptions.

**P1 work:** [#167](https://github.com/yu-iskw/agent-works/issues/167), [#168](https://github.com/yu-iskw/agent-works/issues/168), [#170](https://github.com/yu-iskw/agent-works/issues/170), [#171](https://github.com/yu-iskw/agent-works/issues/171). Respect each existing issue's exclusive path ownership and sequencing.

### 6.3 Workflow definitions, verification and recovery (P2)

The task ledger remains the business source of truth. Cloud Workflows controls progression and callback waits only after its real compatibility/security gate; a Cloud Workflows execution state cannot unilaterally declare an external side effect successful.

If post-restart reconstruction or cross-runtime portability requires it, introduce an **immutable executable definition identity** pinned at admission. That identity should include the resolved ordered step graph/semantics, referenced skill and verifier versions, allowed tools, relevant policy references, and a canonical digest. Do not store arbitrary JavaScript closures as the only recoverable workflow definition. Do not change current persisted contracts without a migration plan.

Define separate outcomes for:
- step ran and returned an output;
- independent verifier accepted the output;
- authorized tool effect was intended;
- provider effect was confirmed with an external receipt;
- provider outcome is unknown and requires reconciliation;
- workflow was cancelled, paused, denied or needs human input.

The verifier is not the executing agent and cannot be replaced by a self-reported success string. For retrieval answers, consider structured source references and explicit grounding verification: a source title appearing in text is not sufficient proof of support.

All side-effect attempts must preserve stable operation identity and fail conservatively after crashes. Do not claim exactly-once external execution unless the target API contract and crash-window tests actually establish it.

**Smallest implementation route:** inventory current local-engine, PostgreSQL and Cloud Workflows recovery tests; write a narrow RFC/ADR for definition pinning only if the inventory shows a real gap. Keep provider-specific reconciliation inside adapters and the existing broker/ledger boundary.

### 6.4 Observability, provenance and privacy (P2)

Use stable task, run, step, parent/child, trace, model-call, tool-call, policy decision, approval and external receipt references to correlate execution. Evaluate version-pinned OpenTelemetry GenAI conventions as a **telemetry mapping**, not a replacement for authoritative append-only business/audit events.

Separate:
- **Audit evidence:** principal, approved action, policy version, immutable digest, effect disposition and authorized access controls.
- **Diagnostic tracing:** durations, error taxonomy, spans and metered usage with short retention.
- **Session/handoff artifacts:** user data subject to source ACLs, classification, consent and deletion policy.

Avoid prompt bodies, raw retrieved documents, OAuth tokens and provider error payloads in ordinary traces. Honor existing governance holds/deletion and export-redaction contracts. Treat missing usage prices as unknown, not zero. Under ADR-0003, dev budgeting remains observe-only.

### 6.5 Integrations and optional read projections (P3)

The current Google Docs, Calendar and Gmail adapters provide an explicit capability, scope and side-effect contract. Preserve this for authoritative writes. Continue requiring per-user credentials (no implicit service-account fallback), approved destination checks, payload-bound approval and stable idempotency keys.

Only assess filesystem-style resource projection if measured discovery ergonomics justify it. Start read-only, path-canonicalized and ACL-aware. Writable projections would need an additional design for optimistic concurrency, provider-side acknowledgement, stale read handling and broker authorization; this RFC does not approve them.

### 6.6 Optional messaging, inbox and handoffs (P3)

Before introducing inter-agent chat, document one use case that cannot be implemented cleanly through existing tasks, child tasks, event triggers and workflow signals.

If needed, conduct a spike for a **durable, scoped inbox** with:
- sender and recipient identities resolved by trusted control plane;
- explicit message ID, ordering scope, idempotency and retention;
- visibility distinct from execution: notification does not automatically become a model prompt;
- bounded handling policy (e.g., notify, actionable request, workflow signal);
- delivery/ack/replay semantics without promising exactly-once effects;
- no authority conveyed solely by message content.

Compare using existing PostgreSQL/outbox infrastructure with external Pub/Sub or a purpose-built messaging library. Choose on demonstrated recovery, operational load, security and cost. An independent chat cluster is not a baseline dependency.

Development-agent continuity issue [#38](https://github.com/yu-iskw/agent-works/issues/38) concerns PR routines and agent handoffs; evaluate structured PR/issue handoff artifacts before treating it as evidence that the enterprise product needs universal chat.

## 7. Pilot validation and release gates

Prioritize proving the **existing** pilot with an end-to-end Google Workspace workflow before adding protocols.

**Proposed reference journey:** authenticated employee -> authorized calendar/Drive retrieval -> grounded result -> bounded draft proposal -> payload-bound human approval -> caller-scoped Google Docs draft creation in a shared drive -> provider receipt -> task/audit evidence -> safe retry and cancellation. The real write remains subject to operator authorization, feature gates and source ACL qualification. CI continues to use deterministic fakes.

### 7.1 Required negative and fault matrix

| Test | Required result |
| --- | --- |
| Actor/agent substitution or spoofed PolicyFacts | Denied before effect |
| Revoked/expired delegated authority at resume or retry | Denied without broadening scope |
| Approval payload or destination changes | Denied; original digest remains authoritative |
| Source ACL changed after retrieval | Revalidated or denied before dependent write |
| Cross-user record read | Owner positive control succeeds; second user denied, zero canary leakage |
| Crash after task/outbox commit but before HTTP response | Same idempotency key returns same accepted task |
| Lease expiry and takeover | Stale fencing token cannot commit transition |
| Crash after provider effect but before receipt storage | Unknown/reconcile; no blind risky replay |
| Duplicate webhook or workflow callback | One admitted task/effect intent within contract |
| Cancellation during provider operation | No false assertion of rollback of already committed effect |
| Missing audit/approval/identity service | Fail closed for privileged actions |
| Provider/model unavailable or cost unmetered | Honest typed failure/unknown accounting and bounded retry |

Some test classes already exist in unit, contract, adversarial and offline PostgreSQL suites. **Inventory and extend existing coverage; do not create a parallel test harness.** A passing fake test is not real-cloud evidence.

### 7.2 Operator-dependent evidence

[#20](https://github.com/yu-iskw/agent-works/issues/20) and its service-specific probes ([#105](https://github.com/yu-iskw/agent-works/issues/105)–[#112](https://github.com/yu-iskw/agent-works/issues/112)) retain the go/no-go/defer authority for managed runtime, identity, model and sandbox features. [#22](https://github.com/yu-iskw/agent-works/issues/22) retains source ACL qualification. [#24](https://github.com/yu-iskw/agent-works/issues/24) owns operator-approved, keyless dev deployment and live identity/E2E. [#161](https://github.com/yu-iskw/agent-works/issues/161) is a needed positive-control prerequisite.

No managed capability is considered supported based only on offline fixtures, marketing materials, provider SDK presence or this RFC. A blocked live test remains **BLOCKED**, not PASS. No deployment/region/latency/SLO claim is established here.

## 8. Migration and compatibility

1. **No flag change in this RFC.** Feature switches for delegation, memory, managed runtime and external writes remain unchanged.
2. **Prefer additive, reversible migrations.** When persisted workflow definitions or evidence types are introduced, version serialized events and maintain a proven reader for old records.
3. **One write authority.** Existing ledger, approval and broker definitions remain authoritative while adapters are refactored. Do not add independent decision stores that can disagree.
4. **No API break by default.** Existing OpenAPI and generated client drift checks must pass; changed endpoints, states or error codes require a separately reviewed contract migration.
5. **Rollback:** preserve old adapter wiring behind explicit configuration until equal-behavior contract and negative tests succeed. Reverting an application adapter must not erase issued permissions, approval evidence or durable task records.
6. **Implementation ownership:** do not amend open issues' exclusive paths or the accepted pilot gates by implication. Split new changes into narrowly owned issues after RFC review.

## 9. Phased delivery, ownership and exit gates

| Phase | Work | Existing owner of scope | Exit gate |
| --- | --- | --- | --- |
| P0 | Canonical authority, cross-user positive control; operator-run pilot evidence | #169, #161, #24, #20 and relevant probes | Security negative tests plus correctly classified real-cloud evidence |
| P1 | Runner and application isolation, contract ownership, architecture fitness | #167, #168, #170, #171 | No public/persisted regression; fake-port use case; dependency enforcement |
| P2 | Workflow definition pinning if justified, verification/effect reconciliation, correlated evidence | New, small issues after P1; existing workflow/ledger owners review | Reproducible crash-window tests and privacy-reviewed trace contract |
| P3 | Inbox/handoffs or read-only integration projection | Separate feasibility spike only | Measured gap versus existing task/event/connector facilities |

P0 and P1 may proceed in parallel **only** where exclusive paths and prerequisite contracts do not conflict. This RFC is not permission to rewrite their scopes. P2/P3 need separately agreed designs, operators and acceptance criteria.

## 10. Alternatives and trade-offs

| Alternative | Decision | Why |
| --- | --- | --- |
| **Do nothing beyond current work** | Plausible short-term baseline | Existing #167–#171 cover much of P1; this RFC must demonstrate incremental value, not manufacture duplicate work |
| **Copy Agent Relay Cloud or its full stack** | Reject | Different product objective, larger operational surface, and no evidence that public repositories reproduce hosted control plane |
| **Adopt an external messaging engine immediately** | Defer | No proven requirement beyond existing durable tasks/events |
| **Replace Cloud Workflows with a new kernel** | Reject for pilot | Duplicates managed orchestration and creates new failure modes without proved need |
| **Switch to Rust/Python or microservices** | Reject | Conflicts with accepted TypeScript/modular-monolith approach without demonstrated benefit |
| **General writable virtual filesystem for SaaS** | Defer | Higher authorization and writeback complexity than current typed connectors |
| **Incremental control-plane consolidation** | Prefer | Low migration risk; directly addresses observed seams and existing issues |

## 11. Risks and unresolved questions

| Risk / unknown | Mitigation / evidence needed |
| --- | --- |
| Unintentional divergence from RFC-001/accepted ADRs | Keep this RFC subordinate; require a separate ADR change for any conflict |
| Scope creep into an agent communication platform | P3 requires a concrete unmet workflow and comparison spike |
| Misstating ADK or managed Agent Runtime capabilities | Enforce port-contract tests and independent operator provider/region qualification |
| False exactly-once external-write claim | Enumerate crash windows, receipt states and provider-specific reconciliation |
| Configuration creates uncontrolled cost | Observe-only dev posture stays; further enforcement requires an approved separate decision |
| Traces leak sensitive source text or credentials | Default metadata-only tracing, redaction and privacy review |
| New workflow version scheme is overengineered | Require demonstrated reconstruction/compatibility gap before implementing |
| New interfaces duplicate existing ports | Establish one owner per invariant and prefer extending existing contracts |
| Too much architecture work delays the pilot | P0 deployment/security blockers take precedence; measure actual value of P1 refactors |

### 11.1 Open review decisions

1. Does the existing workflow persistence model have a **reproducible** replay/definition-identity gap? If not, remove D-05 from the near-term roadmap.
2. Which read-after-write API guarantees exist for each approved external effect, and which should go to human reconciliation instead of automatic retry?
3. What minimum trace metadata is sufficient for debugging and independent verification under current classification/retention policy?
4. Is there an actual enterprise multi-agent use case that existing scheduled tasks, delegation and events cannot solve? If not, keep messaging and handoff protocols out of product scope.
5. Which reviewers and existing issue owners will sponsor any P2 or P3 work once P0/P1 evidence is available?

## 12. Acceptance of this RFC

The proposal is ready to become an accepted direction **only when** reviewers confirm:

- It is compatible with RFC-001 and accepted ADRs, including region, observe-only spend and operator-only cloud changes.
- P0/P1 work primarily **reuses existing issues**, rather than creating duplicate implementation tickets.
- P2 work has a named validation experiment and retains the current business ledger and broker as the source of truth.
- P3 messaging/VFS extensions remain conditional and reversible.
- No claim of production readiness, measured SLO, cloud service compatibility or end-to-end security verification is inferred from the proposal alone.
- Security, IAM, data governance/privacy, platform and operational reviewers have recorded the required decisions before any affected live rollout.

**Requested disposition:** accept / amend / defer / reject the architecture direction; this documentation-only PR should remain draft until the proposal is reviewed. Acceptance of this RFC alone does not activate a capability or authorize production release.

## 13. Source and implementation references

### agent-works (primary)

- [RFC-001](RFC-001-Enterprise-Gemini-Style-Agent-Platform.md); [ADR-0001](../adr/0001-typescript-first-with-adk-js.md); [ADR-0003](../adr/0003-pilot-decisions.md); [ADR-0004](../adr/0004-application-core-and-adapter-boundaries.md)
- [AgentRunner](../../apps/api/src/agent/runner-port.ts), [ADK adapter](../../apps/api/src/agent/adk-runner.ts), [ask route](../../apps/api/src/routes/ask.ts)
- [Canonical authority](../../packages/domain/src/authority.ts), [ToolCall](../../packages/domain/src/tool-call.ts), [broker](../../apps/api/src/broker/broker.ts), [delegation](../../apps/api/src/delegation/orchestrator.ts)
- [Dispatch/lease port](../../apps/api/src/ports/dispatch-port.ts), [Postgres dispatch](../../apps/api/src/ledger/postgres-dispatch.ts), [local workflow engine](../../apps/api/src/workflow/local-engine.ts), [Cloud Workflows adapter](../../apps/api/src/workflow/cloud-workflows.ts)
- [Connector trust boundaries](../connectors/architecture.md), [scheduling verification](../scheduling/verification.md), [governance](../governance/README.md), [threat model](../security/threat-model.md)
- [Current implementation issues #167–#171](https://github.com/yu-iskw/agent-works/issues?q=is%3Aissue+is%3Aopen+167+168+169+170+171), [dev deployment #24](https://github.com/yu-iskw/agent-works/issues/24), [cross-user route #161](https://github.com/yu-iskw/agent-works/issues/161)

### Architectural inspiration (not a dependency or compatibility assertion)

- [Agent Relay](https://agentrelay.com/) and [AgentWorkforce/relay](https://github.com/AgentWorkforce/relay): agent harness and delivery boundaries
- [AgentWorkforce/relaycast](https://github.com/AgentWorkforce/relaycast): durable message delivery and distinction between observer and execution channels
- [AgentWorkforce/flows](https://github.com/AgentWorkforce/flows): deterministic verification gates, durable step outcomes, recovery distinctions
- [AgentWorkforce/relayauth](https://github.com/AgentWorkforce/relayauth): attenuated, resource-scoped agent authority
- [AgentWorkforce/relayfile](https://github.com/AgentWorkforce/relayfile): file projections, concurrency and provider writeback trade-offs
- [AgentWorkforce/c2a](https://github.com/AgentWorkforce/c2a): draft distinction between message visibility, prompt injection and response policy

These external projects are reference points, not requirements to adopt specific libraries, security claims or implementation choices.
