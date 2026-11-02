# Connector runtime: staging plan for a future Cloud Run client

## Status: only the fake exists

Nothing in this document is implemented except the port, the fake and the reconciler.

| Piece                                                | State                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `RuntimeManager` port (`ensure`, `remove`, `status`) | Implemented in `apps/api/src/teamwork/runtime-manager.ts` |
| `FakeRuntimeManager`                                 | Implemented. In memory, bound to one segment, no network  |
| Reconciler (`apps/api/src/teamwork/reconciler.ts`)   | Implemented and tested against the fake                   |
| Upgrade and rollback actions                         | Implemented (`marketplace.ts`)                            |
| Cloud Run client, IAM, Artifact Registry, networking | **Future.** Described below, not built                    |
| Terraform for per-segment services                   | **Future.** No Terraform is changed by this work          |

The segment API wires no real runtime. Unless a caller passes `runtimeManager` to
`createTeamworkRuntime`, it uses `unavailableRuntimeManager`, which fails closed with
`runtime_unavailable` on every call. A deployment therefore cannot pretend to run a connector.

Both first-party connectors, `google` and `github`, run in process. Their manifests have no
`runtime` field, so their rows reconcile to `observed_state = 'not_required'` and the runtime
is never called. A connector is out of process only when its manifest carries
`runtime: { artifactDigest: 'sha256:<64 hex>' }`. No published manifest does today.

## What the reconciler does today

Per segment, one reconciler loop runs next to the task worker (`runtime.start()` and `stop()`).
Each pass lists `tw_installations` and plans each row from `desired_state`, `version` and the
manifest for that exact version.

| Row                          | Plan                                                  | Observed state after success |
| ---------------------------- | ----------------------------------------------------- | ---------------------------- |
| Version not in the catalog   | Fail closed, no runtime call                          | `failed` (`unknown_version`) |
| Manifest without `runtime`   | Nothing to deploy                                     | `not_required`               |
| Runtime manifest, `enabled`  | `ensure(segment, connector, version, artifactDigest)` | `healthy`                    |
| Runtime manifest, `disabled` | `remove(segment, connector)`                          | `disabled`                   |

- **Claim.** The reconciler claims a row with a compare-and-swap on `generation`, writing
  `provisioning`. Of several reconcilers, one wins and the others skip. Admin writes use the
  same compare-and-swap, so an admin change during a runtime call makes the reconciler drop
  its result. The next pass plans from the new row.
- **Lease.** `provisioning` counts as a lease for 60 seconds (`updated_at`). A reconciler that
  died mid-call leaves it, and once it expires any reconciler re-runs the call. `ensure` and
  `remove` are idempotent, so this converges after a restart.
- **Drift.** A row already at its settled state is checked with `status`. A service that was
  deleted, or that runs another version or digest, is rebuilt.
- **Failure.** The row becomes `failed` with a safe code in `observed_detail`
  (`health_check_failed`, `digest_not_in_manifest`, `segment_mismatch`, `quota_exceeded`, and so
  on). Provider error text is never stored. `previous_version` is not touched, so an admin can
  still roll back.
- **Backoff.** Retries wait 1 s, 2 s, 4 s and so on, capped at 60 s. The state is in memory:
  a restart retries at once, and any admin write (a new generation) resets it.
- **Upgrade.** `POST /v1/teamwork/marketplace/connectors/:id` with
  `{ action: 'upgrade', version, expectedGeneration }` sets `version`, stores the old one in
  `previous_version` and marks the row `pending` (`not_required` for an in-process version).
  The target must exist in the catalog, be newer than the installed version and offer every
  enabled capability. Upgrading to the installed version changes nothing.
- **Rollback.** `{ action: 'rollback', expectedGeneration }` returns to `previous_version` and
  clears it. A second rollback is refused with `no_previous_version`, and a replay with a stale
  generation is a 409, so repeats never change state.

### Requirement for M4: the gateway must check `observed_state`

The segment gateway (T5) is not wired to `observed_state`, and this work does not change it.
When the first out-of-process connector arrives (M4), the gateway must, for a connector whose
manifest has a `runtime`, require `observed_state in ('healthy', 'not_required')` on every call,
in addition to its existing activation and `capabilityStates` checks. It must deny with a safe
code on `pending`, `provisioning`, `failed` and `disabled`. In-process connectors must not be
gated by it. Until then a `failed` row has no effect on calls, because only in-process
connectors exist.

## Future Cloud Run client

The real `RuntimeManager` would implement the same three methods against Cloud Run Admin API v2
(`services.create`, `patch`, `delete`, `get`). It would be the only code that imports a Google
client library. Use `google-auth-library`, already a dependency, with plain `fetch` before
adding `@google-cloud/run`.

**Region.** `asia-northeast1`, per [ADR 0003](../adr/0003-pilot-decisions.md). The client must
refuse any other location.

**Naming.** `aw-<segment>-<connector>`, at most 49 characters (the fake enforces this). A segment
id is at most 31 characters and a connector id is short, so a name fits. Service account ids
are limited to 30 characters, so the real client needs a stable shortened form such as
`aw-<hash8>-<connector>` and must keep a mapping from it back to the segment and connector.

**Identity.** One service account per segment and connector, never shared, never the API's own
identity. It holds no project-wide roles. It can read only the secrets that connector needs.
The workload never receives a user credential. User tokens stay in the segment's sealed
`tw_connections`, and a call carries the token for that request only.

**IAM.** The API's reconciler identity needs the least that lets it manage only its own
services:

- `roles/run.developer` on the services it creates, granted at service level, or a custom role
  with `run.services.create`, `run.services.update`, `run.services.delete`, `run.services.get`
  and `run.services.getIamPolicy`/`setIamPolicy` if it must grant invoke.
- `roles/iam.serviceAccountUser` on each connector's service account, and nothing broader.
- `roles/artifactregistry.reader` for the runtime's own service agent on the repository.
- Invoke is granted only to the segment API's identity (`roles/run.invoker`), so a connector
  cannot be called by another segment.

**Artifact Registry digests.** Deploy by digest only: `image@sha256:<64 hex>`, taken from the
manifest's `runtime.artifactDigest`. The manifest for a version is pinned by
`PUBLISHED_CONNECTOR_HASHES`, so the digest cannot change without a new version. The client
must reject a tag, must reject a digest that the manifest for that exact version does not name
(the fake already does, as `digest_not_in_manifest`), and must read the image back from the
service after `ensure` to confirm that the running revision uses that digest. The existing
`cloud_run_service` Terraform module also requires `@sha256:` in `image`.

**Networking.** Ingress `internal` (or `internal-and-cloud-load-balancing` if a load balancer
is required), no public invoker, no `allUsers`. Egress through the segment VPC with Private
Google Access, and an egress allowlist limited to the connector's provider hosts. Calls from
the segment API carry an ID token whose audience is the service URL.

**Quotas.** Check these before enabling a segment, per region (`asia-northeast1`):

- Cloud Run services per project and region (the hard limit that grows with every segment and
  connector).
- Admin API write requests per minute. The reconciler's backoff keeps retries well under it.
- Service accounts per project, and Artifact Registry read requests.
- Total CPU and memory for the region across all instances.

When a quota error comes back, the client maps it to `quota_exceeded` and the row stays
`failed` with that detail instead of retrying hot.

**Cost formula.**

```text
services = enabled segments x out-of-process connectors enabled in each
monthly cost ~ services x (request cost + instance-seconds x vCPU/GiB rates)
             + services x min_instances x idle rate        (zero when min_instances = 0)
             + Artifact Registry storage + egress
```

Only enabled rows count: a disabled row has its service removed. In-process connectors add
nothing. With 5 segments and 2 out-of-process connectors enabled in each, that is 10 services.
Plan quotas and budget for that number, and put it on the cost dashboard so a growth in
segments shows before the bill does.

**Scale to zero.** `min_instances = 0` and a low `max_instances` (start at 2). The first call
after idle pays a cold start, so the gateway timeout for a connector call must cover it. Raise
`min_instances` to 1 only for a connector that proves it needs it, and count it in the formula.

**Safe deletion.**

1. Disable in the marketplace. The row goes to `desired_state = 'disabled'`, and the gateway
   denies new calls at once. A call already inside the handler finishes.
2. The reconciler calls `remove`, which deletes only the service named
   `aw-<segment>-<connector>`. It must check that the service carries the labels
   `aw-segment` and `aw-connector` matching the request, and refuse otherwise, so a name
   collision cannot delete someone else's service.
3. Confirm `observed_state = 'disabled'` and that `status` reports `absent`.
4. Delete the connector's service account and secret versions only as a separate, manual step
   after step 3. The reconciler never deletes identities or secrets.
5. Never delete from the console while a row is `enabled`: the reconciler would rebuild it.
   Disable first.

## Staging checklist

1. Land the real client behind the port, with the fake's tests run against it as a contract
   suite (same names, digest refusal, segment refusal, idempotency).
2. Publish a first out-of-process connector manifest with a `runtime.artifactDigest`, and add its
   hash to `PUBLISHED_CONNECTOR_HASHES`.
3. Wire the gateway requirement above and test it.
4. Add Terraform for the reconciler identity and the repository, reviewed separately. This
   document does not authorize any apply.
5. Run in the staging project with one segment and one connector. Check cold start, quota
   errors, rollback and safe deletion before adding segments.
