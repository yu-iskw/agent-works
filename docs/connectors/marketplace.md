# Marketplace and connector gateway

Admins of a teamwork segment decide which connector capabilities their agents may use.
Members browse the marketplace, and every source fetch and write is rechecked against
the admin's choice on each call.

The decision record is [ADR 0006](../adr/0006-curated-marketplace-and-connector-gateway.md).
It is **Proposed**, not Accepted. This page describes the merged code.

## Concepts

| Term         | Meaning in the code                                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Workspace    | A teamwork **segment**: one process, one database, one member allowlist. There is no `workspace_id` column.                         |
| Connector    | A first-party manifest in `packages/domain/src/connector-catalog.ts`: provider (`google` or `github`), version and capabilities.    |
| Capability   | One of `drive.read`, `bigquery.query`, `docs.publish`, `github.read`, `files.read` (`packages/domain/src/teamwork.ts`).             |
| Installation | One row per connector in the segment DB, table `tw_installations` (`apps/api/migrations/0023_installations.sql`).                   |
| Admin        | A segment member listed in `AW_M1_<SEG>_ADMINS` (`AW_LOCAL_TEST_ADMINS` with local identity). Non-members listed there are ignored. |

## Architecture

```text
catalog (code)           segment DB                      per call
CONNECTOR_CATALOG  ->  tw_installations  ->  segmentCapabilities()  ->  gateway invoke()
 manifests, hashes     desired state,         env allowlist ∩          recheck, then handler
                       version, subset        enabled subset           via tokenSource
```

- **Catalog.** Manifests are compiled from code. There is no catalog table and no
  third-party publishing. `PUBLISHED_CONNECTOR_HASHES` pins a content hash per version, so a
  published version stays immutable.
- **Effective set.** `segmentCapabilities` (`apps/api/src/teamwork/installations.ts`) is the
  env allowlist (`AW_SEGMENT_CAPABILITIES`) intersected with the capabilities of every
  enabled installation. It is read on every request with no cache. A row can only remove a
  capability the env allows, never add one. `files.read` has no provider and stays env-only.
- **Bootstrap.** On start the segment inserts one enabled row per env-allowed provider
  (`insert … on conflict do nothing`, actor `system:bootstrap`). Existing segments keep
  their behavior, and an admin's later disable persists.
- **Gateway.** `apps/api/src/teamwork/gateway.ts` runs source fetches and
  `docs.publish` (both in `worker.ts`) through one `invoke`. Per call it checks, in order: the
  member is still in the segment, the tool exists in the registry, the capability is in
  `segmentCapabilities`, `capabilityStates` is effective for the member, teammate and task,
  the input matches the tool's strict schema, and for a write the approval digest and
  revision still match. Only then does the handler run, with a token from `tokenSource`.
  Provider text in the result is wrapped as untrusted source data.
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
| `mcp_server` | Placeholder entry                               | `coming_soon`                           |
| `a2a_agent`  | Placeholder entry                               | `coming_soon`                           |

### HTTP API

All paths are under `/v1/teamwork` and need the member assertion web mints for the
segment. Every request checks membership server-side.

| Method and path                    | Who    | Purpose                                                        |
| ---------------------------------- | ------ | -------------------------------------------------------------- |
| `GET /marketplace?kind=`           | Member | Listings, plus `admin: true/false` for the caller              |
| `GET /marketplace/installations`   | Member | Installation rows                                              |
| `GET /marketplace/:kind/:id`       | Member | One item; a connector shows per-capability state               |
| `POST /marketplace/connectors/:id` | Admin  | `enable`, `disable`, `set_capabilities`, `upgrade`, `rollback` |

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

| Piece                                               | State                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Catalog, installations, admin allowlist, API and UI | **Real.** Backed by the segment Postgres database.                                    |
| Per-call recheck in the segment gateway             | **Real** for source fetches and `docs.publish` (see limitations).                     |
| Flagship broker registry                            | **Real.** Tool dispatch is a registry; policy and approval order are unchanged.       |
| Runtime port, `FakeRuntimeManager` and reconciler   | **Simulated.** The fake is in memory and bound to one segment. No cloud call is made. |
| Default runtime manager                             | `unavailableRuntimeManager`: every call fails closed with `runtime_unavailable`.      |
| In-process connectors (`google`, `github`)          | Reconcile to `observed_state = 'not_required'`. The runtime is never called.          |

### Future, not built

- **Cloud Run client.** Only the fake exists. See the plan in
  [connector-runtime-staging](../runbooks/connector-runtime-staging.md).
- **MCP adapter.** The MCP listing is `coming_soon`. The adapter is a separate, gated change.
- **A2A execution.** The A2A listing is metadata only. Nothing fetches an Agent Card or
  delegates to an agent.
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
- **One version per connector.** The catalog holds one manifest per connector, and the
  gateway builds its registry from the catalog at load, not from the installed `version`.
  `upgrade` and `rollback` move the stored version and drive the reconciler. The shipped
  catalog has no second version to move to. The tests inject a manifest lookup.
- **Upgrade and rollback have no UI.** The page offers enable, disable and capability
  changes. `upgrade` and `rollback` are API-only.

## Related

- [Add a connector](add-a-connector.md)
- [Connector operations runbook](../runbooks/connector-operations.md)
- [Connector runtime staging](../runbooks/connector-runtime-staging.md)
