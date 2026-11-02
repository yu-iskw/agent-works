# 5. Curated marketplace and connector gateway

Date: 2026-11-02

## Status

Proposed

## Context

The platform needs curated marketplaces (connectors, team bots, MCP servers, A2A agents) and a way for workspace admins to govern which connector capabilities agents may use. Today the available capabilities are a static env allowlist (`AW_SEGMENT_CAPABILITIES`), snapshotted into `tw_assignments.capabilities` at dispatch. Source fetches and `docs.publish` do not recheck activation at call time. The flagship broker (`apps/api/src/connectors/broker.ts`) dispatches tools through a hard-coded `switch`.

Existing pieces are reused rather than replaced: the teamwork skill and template catalog, `toolManifestSchema`, `capabilityStates`, `tokenSource` and sealed `tw_connections`, the segment `wb_approvals` and flagship approval stores, `tw_audit`, and the flagship broker's authorization order.

This record is Proposed. A human accepts it with `manage-adr` Accept. It does not change ADRs 0001 to 0004, and it fits ADR 0004: ports for the registry and `RuntimeManager`, adapters behind them, `apps/api` as the composition root.

## Decision

The ten architectural decisions from the spec:

1. **Hybrid connector architecture.** Trusted built-in TypeScript adapters now. Isolated MCP-capable connector services later (M4). A central registry. No in-process hot-loading of arbitrary code.
2. **Provider core plus independent capability adapters.** One provider (google, github) owns authentication and client logic. Read and write capabilities are separate adapters, enabled independently.
3. **Hybrid credential ownership.** User-owned delegated OAuth is the default. Workspace service identities are future. There is no implicit fallback from a user to a service credential, and a test asserts this.
4. **Hierarchical policy governance.** Deny by default. `capabilityStates` already intersects segment, member, teammate, connected and task. Activation is added as one more intersected input. No second policy engine.
5. **Capability manifests and per-tool policies.** Each capability declares tools (existing `toolManifestSchema`), side effect, scopes and a version. Authorization is enforced at discovery and again at invocation. Visibility is not authorization.
6. **Managed marketplace lifecycle.** Install, enable, disable, upgrade, rollback and uninstall, with no core API restart. Runtime orchestration sits behind a `RuntimeManager` port. Only a fake and a reconciler are built (see Q4).
7. **First-party publishing only.** Only Agent Works maintainers publish. There are no third-party submissions, uploaded code or unreviewed MCP endpoints. This holds for the MCP and A2A catalogs too.
8. **Per-workspace, per-connector runtime first.** Runtime isolation is keyed by workspace and connector. Ephemeral per-invocation execution is a non-goal. The tool contract does not hard-code an execution model.
9. **Central credentials with just-in-time access.** The broker and `tw_connections` own persistent secrets. A handler receives a token for one call. Secrets never become long-lived runtime environment configuration.
10. **Central tool gateway with pluggable transports.** One canonical versioned tool contract and one trusted execution point. Native TypeScript and MCP are transports behind it. There is no direct agent-to-connector path.

### Answers to the open questions (binding)

| Q   | Answer                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | A workspace is a teamwork **segment**. Activation lives in each segment's own DB and narrows the env allowlist. No new tenant model, and `tw_installations` has no `workspace_id`. The segment DB is the tenant boundary.                                                                                                                                                           |
| Q2  | Admin authority is a per-segment allowlist `AW_M1_<SEG>_ADMINS`, from the same secrets file as `MEMBERS`. An admin must also be a member. It is checked server-side in `routes.ts`, with no directory coupling and no feature flag on mutations.                                                                                                                                    |
| Q3  | The segment is the gateway's home. One segment invoke function handles every source fetch and `docs.publish`. Per call it rechecks activation and `capabilityStates`, then dispatches through a manifest-keyed adapter registry. The flagship broker's `switch` is replaced by the same registry shape. The flagship keeps its approval store and the segment keeps `wb_approvals`. |
| Q4  | M3 covers the `RuntimeManager` port, a fake and a reconciler, plus a runbook for a future Cloud Run client. No Cloud Run client code and no new GCP dependency. The real runtime path stays future.                                                                                                                                                                                 |
| Q5  | M4 (MCP) is planned fully as a later, separately gated subtask using `@modelcontextprotocol/sdk` (at least 7 days old) and an in-process test server. M5 is folded into the M1 browse API and UI. MCP and A2A show `coming_soon` until M4 lands. Team bots are a projection over the existing teamwork catalog.                                                                     |

### Scope, reuse and non-goals

| Area       | Reuse                                                  | New (small)                                                              | Not built                                             |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| Tenant     | Segment process and DB                                 | Nothing                                                                  | `workspace_id`, org level                             |
| Admin      | `MEMBERS` secrets pattern                              | `AW_M1_<SEG>_ADMINS`                                                     | Role or group UI                                      |
| Catalog    | `toolManifestSchema`, teamwork catalog                 | `connector-cdk.ts` and a first-party manifest catalog compiled from code | Catalog table, third-party publishing, reviews        |
| Activation | Segment DB, `tw_audit`                                 | One table, `tw_installations`                                            | Workflow tables, event bus                            |
| Policy     | `capabilityStates`                                     | Activation as an intersected input                                       | Second policy engine                                  |
| Gateway    | `tokenSource`, `sources/*`, approvals, flagship broker | Segment invoke plus registry                                             | Standalone network gateway                            |
| Runtime    | `tw_jobs` lease idea                                   | `RuntimeManager` port, fake, CAS reconciler                              | Cloud Run client, Terraform apply, Kubernetes         |
| MCP        | Gateway and registry                                   | SDK dependency, adapter, in-process test server                          | Homegrown JSON-RPC, remote OAuth, arbitrary endpoints |
| Team bot   | `listTemplates`, `listSkills`, create flow             | Projection rows and links                                                | New bot store or runtime                              |
| A2A        | Nothing                                                | `coming_soon` listing                                                    | Execution, Agent Card fetch                           |

Also not built: workspace service identities, a `packages/connector-cdk` package (the domain owns manifests), a CLI scaffolder, a second approval or credential store.

### Data model

Activation is one table in the segment DB, `tw_installations`, keyed by `(item_kind, item_id)`. It holds the installed `version`, `previous_version`, the enabled `capabilities` subset, `desired_state`, `observed_state`, a safe `observed_detail` code and an integer `generation`. `generation` is the compare-and-swap token for admin writes and the reconciler. The effective segment capability set is the env allowlist intersected with the union of capabilities from enabled rows. It is read on every request with no cache. On segment start, one row per env-allowed provider is inserted with `on conflict do nothing` (actor `system:bootstrap`), so existing segments keep their behavior and a later disable persists.

## Data flow

```text
Admin (member in AW_M1_<SEG>_ADMINS)
  | POST /v1/teamwork/marketplace/connectors/:id  {action, expectedGeneration}
  v
routes.ts: admin check -> manifest exists -> caps within manifest and env allowlist
  -> CAS on tw_installations.generation (409 if stale) -> tw_audit
                                                     |
                                       (M3) reconciler --> RuntimeManager (fake)

Agent task (worker.ts source fetch, tasks.ts docs.publish)
  v
gateway invoke(member, {tool, input, taskId, assignmentId})        [segment process]
  1. member still entitled
  2. tool exists in registry          <-- manifest-keyed registry
  3. capability in segmentCapabilities (env allowlist AND enabled installations)
  4. capabilityStates effective for teammate, task, member
  5. connection active                <-- tw_connections / tokenSource
  6. input strict-parsed
  7. write: approval check            <-- wb_approvals (flagship: exact-payload approval store)
  8. handler runs with a just-in-time token
  9. result wrapped as source data
```

## Threat boundaries

- **Tenant isolation.** The segment DB, key directory and member allowlist are the boundary. A user in two segments has separate rows, keys and connections. Selection is by segment URL and assertion audience `segment:<id>`.
- **Server-side only.** Admin, activation and policy checks run server-side and fail closed. Identity and actor never come from request args.
- **Check at call time.** Discovery visibility is not authorization. A disable denies new calls at once. A call already inside a handler finishes. This is documented, not hidden.
- **Read and write independence.** Enabling a read capability never adds the write capability.
- **Credentials.** User-owned only. No fallback to a service credential. Revoked, expired and missing-scope tokens fail through the existing `tokenSource` errors. `tw_audit.detail` and logs carry no secrets or provider bodies.
- **Untrusted tool output.** Results are wrapped as source data. Malformed manifests and unknown tools are rejected. Hosts stay on the existing `google-http.ts` allowlist.
- **Concurrency.** Enable, disable and upgrade race through CAS on `generation`.
- **Runtime.** Only the fake is built. No claim of real deployment is made.

## Consequences

- The segment gains a mutable activation layer with no new tenant model and no new credential or approval store.
- Call-time enforcement closes the gap between dispatch-time snapshots and admin disable.
- The flagship and the segment share one registry shape, and the broker `switch` goes away.
- MCP and A2A are visible in the catalog but not executable until M4 and later work land.
- A real per-workspace runtime path (Cloud Run) remains future work, described by a runbook.
- Segment `wb_approvals` semantics are narrower than the flagship's exact-payload, one-execution binding. The gateway work must confirm a digest binding for `docs.publish`, and a gap is filed as a defect.

## Alternatives considered

### A new workspace or tenant model

Rejected. The segment already is one process, one DB and one key directory. A second boundary adds a mapping that can disagree with the first.

### A standalone network gateway service

Rejected. It adds a hop and a service for no isolation gain while connectors stay in-process. The port keeps the option open.

### Directory-backed admin

Rejected for now. The segment has no directory coupling. A secrets allowlist matches how `MEMBERS` already works.

### A catalog database table

Rejected. First-party manifests compiled from code are versioned by review, and only maintainers publish.
