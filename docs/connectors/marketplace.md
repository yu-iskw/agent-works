# Marketplace and connector gateway

Admins of a teamwork segment decide which connector capabilities their agents may use.
Members browse the marketplace, and every source fetch and write is rechecked against
the admin's choice on each call.

The decision record is [ADR 0006](../adr/0006-curated-marketplace-and-connector-gateway.md).
It is **Proposed**, not Accepted. This page describes the merged code.

## Concepts

| Term         | Meaning in the code                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace    | A teamwork **segment**: one process, one database, one member allowlist. There is no `workspace_id` column.                                            |
| Connector    | A first-party manifest in `packages/domain/src/connector-catalog.ts` (`CONNECTOR_CATALOG`): provider (`google` or `github`), version and capabilities. |
| MCP server   | A first-party manifest in the same file (`MCP_SERVER_CATALOG`) with `transport: 'mcp'`. The only one today is `notes` (Team notes).                    |
| Capability   | One of `drive.read`, `bigquery.query`, `docs.publish`, `github.read`, `files.read`, `notes.read`, `notes.write` (`packages/domain/src/teamwork.ts`).   |
| Installation | One row per connector or MCP server in the segment DB, table `tw_installations` (`apps/api/migrations/0023_installations.sql`).                        |
| Admin        | A segment member listed in `AW_M1_<SEG>_ADMINS` (`AW_LOCAL_TEST_ADMINS` with local identity). Non-members listed there are ignored.                    |

## Architecture

```text
catalog (code)           segment DB                      per call
CONNECTOR_CATALOG  ->  tw_installations  ->  segmentCapabilities()  ->  gateway invoke()
 manifests, hashes     desired state,         env allowlist ∩          recheck, then handler
                       version, subset        enabled subset           via tokenSource
```

- **Catalog.** Manifests are compiled from code. There is no catalog table and no
  third-party publishing. `MCP_SERVER_CATALOG` holds the first-party MCP servers. It sits
  next to `CONNECTOR_CATALOG` in the same file, and the gateway registry and the marketplace
  read both. `PUBLISHED_CONNECTOR_HASHES` pins a content hash per version, so a published
  version stays immutable.
- **Effective set.** `segmentCapabilities` (`apps/api/src/teamwork/installations.ts`) is the
  env allowlist (`AW_SEGMENT_CAPABILITIES`) intersected with the capabilities of every
  enabled installation. It is read on every request with no cache. A row can only remove a
  capability the env allows, never add one. `files.read` has no provider and stays env-only.
  When the variable is unset, the segment gets `DEFAULT_SEGMENT_CAPABILITIES`, which leaves
  out the MCP capabilities (`notes.*`).
- **Bootstrap.** On start the segment inserts one enabled row per env-allowed provider
  (`insert … on conflict do nothing`, actor `system:bootstrap`). Existing segments keep
  their behavior, and an admin's later disable persists.
- **Gateway.** `apps/api/src/teamwork/gateway.ts` runs source fetches and `docs.publish`
  (both called from `worker.ts`) and the MCP tools `notes.search` and `notes.append` through
  one `invoke`. Per call it checks, in order: the member is still in the segment, the tool
  exists in the registry, the capability is in `segmentCapabilities`, `capabilityStates` is
  effective for the member, teammate and task, the input matches the tool's strict schema,
  and for a write the approval digest and revision still match. Any approval policy other
  than `segment-publish-v1` denies, so `notes.append` is refused. Only after these checks
  does the handler run. A source handler gets a token from `tokenSource`. Provider text in
  the result is wrapped as untrusted source data.
- **Flagship broker.** `apps/api/src/connectors/broker.ts` dispatches through a registry
  built by `createWorkspaceRegistry` in `ports.ts`. It uses the same `defineRegistry` from
  `packages/domain/src/connector-cdk.ts` but its own handler type, approval store and
  credentials port. The two hosts share the registry shape, not the gateway.
- **Marketplace API and UI.** Routes are in `apps/api/src/teamwork/routes.ts` and
  `marketplace.ts`; schemas are in `packages/domain/src/marketplace.ts`. The Marketplace
  page lives in `apps/web/app/m1/` at `/s/<segment>/marketplace`.

### Marketplace listings

| Kind         | Source                                          | Status                                  |
| ------------ | ----------------------------------------------- | --------------------------------------- |
| `connector`  | `CONNECTOR_CATALOG` plus the installation row   | `available`, `enabled` or `disabled`    |
| `team_bot`   | A projection of the existing teamwork templates | `available`; links to the template flow |
| `mcp_server` | `MCP_SERVER_CATALOG` plus the installation row  | `available`, `enabled` or `disabled`    |
| `a2a_agent`  | Placeholder entry                               | `coming_soon`                           |

Only `a2a_agent` is `coming_soon`. A2A execution is not built.

### MCP servers

The `notes` server ("Team notes (MCP)") is the first-party MCP server. The gateway reaches
it through `apps/api/src/teamwork/mcp-adapter.ts`, which uses the MCP SDK client.

| Tool           | Capability    | Side effect | What happens today                                                                                                 |
| -------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `notes.search` | `notes.read`  | `READ`      | Runs through the gateway. Fails with `mcp_unavailable` until a transport is set (see [Future](#future-not-built)). |
| `notes.append` | `notes.write` | `WRITE_LOW` | Always refused with `approval_invalid`.                                                                            |

- **Opt-in.** `notes.read` and `notes.write` are not in the default segment allowlist. To
  offer the server, list them in `AW_SEGMENT_CAPABILITIES`. An unset variable never enables
  it. `available` means no installation row exists, which is the case while the env allows
  no `notes.*` capability. Then `enabled` or `disabled` follows the row.
- **No member connection.** `notes` is a connectionless provider. The server needs no
  per-member OAuth connection, so its capabilities count as connected.
- **Read never grants write.** `notes.write` is its own capability and sits in
  `WRITE_CAPABILITIES`. Enabling `notes.read` never adds it. The env must list it, and an
  admin must select it on the installation.
- **Writes are refused.** The manifest gives `notes.append` policy `mcp-write-v1`. The
  gateway accepts only `segment-publish-v1`, so it denies the call with `approval_invalid`
  before any handler runs. The handler also fails closed, and the adapter refuses a write
  that is not enabled (`mcp_write_disabled`). Writes stay refused until an MCP approval
  path exists. That is a separate change.

#### What the adapter guarantees

- **Pinned tools.** The pins come from the manifest, not from the server. A session lists
  only tools that are pinned and enabled. A server that advertises any other tool fails at
  connect with `mcp_manifest_mismatch`.
- **No read-to-write flip.** A pinned read tool must still be annotated `readOnlyHint: true`
  and must not set `destructiveHint: true`. The adapter checks this at connect and again
  before every call. A flip fails with `mcp_manifest_mismatch`, and the call never runs.
- **Unknown and disabled tools.** A tool that is not pinned fails with `mcp_unknown_tool`.
  A pinned write that is not enabled fails with `mcp_write_disabled`.
- **Timeout and cancellation.** Connect and each call stop after 10 seconds by default
  (`mcp_timeout`). The caller's `AbortSignal` stops a call with `mcp_cancelled`.
- **Output cap.** The text of one result is capped at 64 KiB by default
  (`mcp_output_too_large`). The check runs after the SDK has read the response. It limits
  what the gateway returns, not what is received.
- **Hosts and redirects.** `mcpHttpTransport` talks only to hosts on the caller's
  allowlist, over `http` or `https`, with no credentials in the URL. It checks the host on
  every request. It sends `redirect: 'manual'` and fails any 3xx with `mcp_redirect`.
- **Safe errors.** Every failure maps to one of eleven codes with a fixed message. Upstream
  text never reaches the error, the denial reason or the audit row. The audit row keeps the
  code and the tool name.
- **Results as source data.** The gateway returns the match count as the value. Each
  matched text goes out wrapped as untrusted source data.

### HTTP API

All paths are under `/v1/teamwork` and need the member assertion web mints for the
segment. Every request checks membership server-side.

| Method and path                    | Who    | Purpose                                                        |
| ---------------------------------- | ------ | -------------------------------------------------------------- |
| `GET /marketplace?kind=`           | Member | Listings, plus `admin: true/false` for the caller              |
| `GET /marketplace/installations`   | Member | Installation rows                                              |
| `GET /marketplace/:kind/:id`       | Member | One item; a connector shows per-capability state               |
| `POST /marketplace/connectors/:id` | Admin  | `enable`, `disable`, `set_capabilities`, `upgrade`, `rollback` |

MCP servers use the same mutation route, with `notes` as the id.

The mutation body is strict. It carries `action`, `expectedGeneration` and the action's
own fields (`capabilities`, `version`). A body that names a segment or actor is rejected
with 400, because both come from the verified assertion.

Every write is a compare-and-swap on `generation`. A stale value returns
`409 stale_generation`. **Reconciler writes also bump `generation`**, so a form loaded
before a reconcile write gets a 409 and must reload. The Marketplace page shows the
current state after a 409.

Capabilities must sit inside the manifest and the env allowlist. Enabling a read
capability never adds the write capability, because the stored subset is explicit.

## What is real and what is simulated

| Piece                                               | State                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Catalog, installations, admin allowlist, API and UI | **Real.** Backed by the segment Postgres database.                                                               |
| Per-call recheck in the segment gateway             | **Real** for source fetches, `docs.publish` and the MCP tools (see limitations).                                 |
| MCP adapter and the `notes` server                  | **Real** code, tested against an in-process server. No segment sets a transport, so `notes.search` fails closed. |
| Flagship broker registry                            | **Real.** Tool dispatch is a registry; policy and approval order are unchanged.                                  |
| Runtime port, `FakeRuntimeManager` and reconciler   | **Simulated.** The fake is in memory and bound to one segment. No cloud call is made.                            |
| Default runtime manager                             | `unavailableRuntimeManager`: every call fails closed with `runtime_unavailable`.                                 |
| In-process connectors (`google`, `github`)          | Reconcile to `observed_state = 'not_required'`. The runtime is never called.                                     |

### Future, not built

- **Cloud Run client.** Only the fake exists. See the plan in
  [connector-runtime-staging](../runbooks/connector-runtime-staging.md).
- **MCP transport in a segment.** The adapter has an HTTP transport. No segment sets
  `Deps.mcp`, so nothing reaches an MCP server yet. Wiring one is its own change.
- **MCP writes.** `notes.append` has no approval path. Policy `mcp-write-v1` has none yet.
- **A2A execution.** The A2A listing is `coming_soon` metadata only. Nothing fetches an
  Agent Card or delegates to an agent.
- **Service identities.** Credentials are user-owned (`tw_connections`). No workspace
  service identity exists, and nothing falls back to one.
- **Organization policy level.** The segment is the top level.

## Known limitations

- **Non-gateway read paths.** The uncertain-write reconcile in `routes.ts` calls
  `sources.findPublished` directly, and `checkSources` in `diagnostics.ts` calls
  `sources.read` directly. Both are limited by the activation-aware member capabilities,
  but neither passes through the gateway, so neither writes a `gateway.denied` audit row.
- **`observed_state` is not checked by the gateway.** That is safe while every connector
  is in process. Before the first out-of-process connector, the gateway must require
  `observed_state in ('healthy', 'not_required')` for it.
- **One version per connector.** Each manifest in either catalog is one version. The
  gateway builds its registry from both catalogs at load, not from the installed `version`.
  `upgrade` and `rollback` move the stored version and drive the reconciler. The shipped
  catalog has no second version to move to. The tests inject a manifest lookup.
- **One MCP transport factory.** `Deps.mcp` is a single factory for one server. A second
  MCP server needs a per-server factory first.
- **Upgrade and rollback have no UI.** The page offers enable, disable and capability
  changes. `upgrade` and `rollback` are API-only.

## Related

- [Add a connector](add-a-connector.md)
- [Connector operations runbook](../runbooks/connector-operations.md)
- [Connector runtime staging](../runbooks/connector-runtime-staging.md)
