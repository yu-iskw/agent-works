# Connector operations

How a segment admin or operator enables, disables, upgrades and rolls back a connector, and
how to run and test the platform locally. For the design see
[Marketplace](../connectors/marketplace.md).

## Before you start

- A segment is the workspace. Each segment has its own database, so a change in `alpha`
  never touches `beta`.
- Only an admin can mutate. Admins are listed in `AW_M1_<SEG>_ADMINS` in the segment
  secrets file (`AW_LOCAL_TEST_ADMINS` with local identity) and must also be members. An
  admin who is not a member is ignored, and `/readyz` reports the missing key by name.
- The marketplace can only narrow the segment env allowlist `AW_SEGMENT_CAPABILITIES`. To
  offer a capability the env does not allow, change the env and restart the segment.
- The env default, when the variable is unset, is the native capabilities only. The MCP
  capabilities `notes.read` and `notes.write` are opt-in. Listing them allows the capability
  in the env, but the `notes` server stays uninstallable until `Deps.mcp` is wired.

## Enable, disable and change capabilities

Use the Marketplace page at `/s/<segment>/marketplace?kind=connector`. The controls render
only for admins, and the server checks the role again on every write.

| Action             | Effect                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------- |
| `enable`           | Sets `desired_state = enabled`. Omitting `capabilities` re-enables the stored subset.  |
| `disable`          | Sets `desired_state = disabled`. The connector's capabilities leave the effective set. |
| `set_capabilities` | Replaces the enabled subset. Read and write are independent.                           |

The same actions are `POST /v1/teamwork/marketplace/connectors/:id` with a JSON body, for
example `{ "action": "disable", "expectedGeneration": 3 }`. The call needs the member
assertion web mints for the segment, so use the page or the test harness, not a bare
request.

- **No restart.** The effective set is read on every request.
- **Enabling read does not enable write.** To allow `docs.publish`, select it explicitly.
- **MCP server.** While `Deps.mcp` is unwired (every segment today), the `notes` server is
  `coming_soon`. `kind=mcp_server` shows the placeholder, and `enable` through
  `POST /v1/teamwork/marketplace/connectors/notes` is refused with `409 connector_not_available`.
  `disable` still works for a row left from an earlier version. `notes.write` stays refused,
  even when enabled. See [MCP servers](../connectors/marketplace.md#mcp-servers).
- **Audit.** Each write adds a `tw_audit` row (`installation.enable`, `installation.disable`
  and so on) with the connector and actor email, never provider text.

### A 409 means reload

Every write compares `generation`. `409 stale_generation` means the row changed after the
page loaded. That includes the reconciler: its writes bump `generation` too. Reload, check
the new state, and decide again. Retrying with the old value never succeeds.

Other refusals: `403 forbidden` (not an admin), `400 capability_not_allowed` (outside the
manifest or env allowlist), `409 connector_not_available` (the env offers none of its
capabilities, or it is an MCP server while `Deps.mcp` is unwired).

## What a disable does to work in flight

| Situation                                        | Result                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| A task plans, then an admin disables, then fetch | The fetch is denied (`capability_disabled`). No token is read and no upstream call is made. |
| A call is already inside its handler             | It **finishes**. Nothing interrupts an upstream request in flight.                          |
| A write approved before the disable              | Denied on the next call. The approval is not consumed or revoked.                           |
| Tasks that already hold the capability snapshot  | The snapshot cannot widen anything. The live set is rechecked per call.                     |

Denials write a `gateway.denied` row in `tw_audit` with the safe code and the tool name.
Two read paths bypass the gateway: the uncertain-write reconcile and the source check on the
Connections page. They respect activation but write no `gateway.denied` row.

## Upgrade and rollback

These are API-only. The page has no control for them.

- `{ "action": "upgrade", "version": "x.y.z", "expectedGeneration": n }`. The target must be
  in the catalog, not older than the installed version, and offer every enabled capability.
  The old version is stored in `previous_version`. Upgrading to the installed version changes
  nothing.
- `{ "action": "rollback", "expectedGeneration": n }`. Returns to `previous_version` and
  clears it. A second rollback fails with `no_previous_version`.

An in-process connector goes to `observed_state = not_required` at once. A connector with a
`runtime` goes to `pending` and waits for the reconciler.

The shipped catalog has one version per connector, so neither action has a target in a
production build yet. Both work against any manifest lookup; the tests inject one.

## Reading the state

`GET /marketplace/installations` returns, per connector, `desiredState`, `observedState`,
`observedDetail`, `version`, `previousVersion` and `generation`.

| `observedState` | Meaning                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `not_required`  | In-process connector or MCP server with no runtime. Nothing to deploy. Every shipped connector and the `notes` server. |
| `pending`       | Version moved. The reconciler has not run yet.                                                                         |
| `provisioning`  | The reconciler claimed the row. A 60 s lease; then another takes over.                                                 |
| `healthy`       | The runtime reports the service ready at the right version and digest.                                                 |
| `disabled`      | Disabled and the runtime service removed.                                                                              |
| `failed`        | See `observedDetail`, a safe code such as `health_check_failed`.                                                       |

On `failed`, `previous_version` is kept. Fix the cause or roll back. The reconciler retries
with a 1 s to 60 s backoff, kept in memory.

## What is real and what is simulated

- **Real:** the catalog, `tw_installations`, the admin allowlist, the API, the page, the
  per-call gateway recheck and the MCP adapter (tested with an in-process server).
- **Simulated:** the runtime. `createTeamworkRuntime` uses `unavailableRuntimeManager`
  unless a caller passes a `runtimeManager`. It refuses every call. Only the in-memory
  `FakeRuntimeManager` in tests succeeds.
- **Future:** a Cloud Run client ([plan](connector-runtime-staging.md)), an MCP transport
  wired into a segment (until one is set, MCP servers are `coming_soon` and `notes.search`
  returns `mcp_unavailable`), MCP write approval, A2A execution and workspace service
  identities. Do not promise these to users. The gateway also does not check
  `observed_state` yet; that must land before any out-of-process connector.

## Local development and test

```bash
pnpm install
pnpm build && pnpm typecheck
pnpm --filter @agent-works/domain test        # CDK, catalog pin, add-a-connector guide
pnpm --filter @agent-works/api test           # gateway, marketplace, reconciler, installations, MCP adapter
pnpm --filter @agent-works/web test           # Marketplace page
```

- **Postgres suites.** Installation, gateway and marketplace tests call
  `startDisposablePostgres` (`apps/api/src/ledger/disposable-postgres.ts`). It uses a local
  PostgreSQL 16 install if present and Docker otherwise. Without either, the suites cannot
  start. Record them as skipped, not passed.
- **Fake sources.** Set `AW_SOURCE_MODE=fixture` to run without Google or GitHub. Tests use
  the fixture source port.
- **Local stack.** `pnpm m1:up` starts two segments, `alpha` and `beta`, with fake or live
  sources per your secrets file. Open `http://localhost:8280/s/alpha/marketplace` as an admin.
  `compose.m1.yaml` sets `AW_LOCAL_TEST_ADMINS: alice@local.test`. See
  [M1 setup](../m1/README.md).
- **Isolation check.** Disable `google` in `alpha`, then confirm `beta` still lists it
  enabled.

Before a commit: `pnpm lint:eslint && pnpm knip && pnpm lint && pnpm test`.
