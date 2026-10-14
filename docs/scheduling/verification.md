# Scheduling verification and review guide

The scheduler is an offline control-plane service. Review its authority boundaries
and crash behavior independently of the UI. A successful source signature proves
where an envelope came from; it does not supply consent or authorize a broader task.

## Required evidence

| Boundary                | Test evidence                       | Expected result                                                                   |
| ----------------------- | ----------------------------------- | --------------------------------------------------------------------------------- |
| Sponsor identity        | Domain and schedule route tests     | Only the authenticated sponsor can create or mutate their schedule                |
| Privilege ceiling       | Domain and service tests            | Every authority dimension stays within the sponsor's current grant                |
| Consent binding         | Service and revocation tests        | Reference, subject, spec hash and grant expiry all match                          |
| Timer identity          | Shared port contract                | A schedule and UTC slot produce one claim                                         |
| Event identity          | Shared port and ingestion tests     | A source event ID is recorded once, atomically with its run                       |
| Lease recovery          | Shared port and service tests       | A takeover increases the fence and rejects stale completion                       |
| Revocation races        | Admission race tests                | No dispatch after admission notices a pause, expiry or authority loss             |
| Committed task recovery | Admission race tests                | Revocation finds and cancels a task whose completion acknowledgement was lost     |
| Source authentication   | Signature and event isolation tests | Raw body, trigger ID, source, event ID, timestamp and key ID are signed           |
| Replay freshness        | Ingestion and event isolation tests | Exact replay boundary accepted; future and older events rejected                  |
| Input confinement       | Ingestion tests                     | Payload stays untrusted evidence and never changes the pinned task                |
| Suspension              | Service and admission race tests    | Global, team, skill, agent, user and model suspension block admission             |
| Budget                  | Service and reconciliation tests    | Enforced test limits deny exhausted runs and release concurrency on completion    |
| API ownership           | Route tests                         | A second sponsor cannot enumerate another sponsor's runs or history               |
| Web mutation            | Web handler tests                   | CSRF and current revision are required before API access                          |
| Browser workflow        | Playwright smoke                    | List, preview, create, pause and resume use real HTML forms                       |
| Persistence             | Postgres contract                   | Independent pools see one slot, restart preserves state, audit rollback is atomic |

## Running the checks

Build the workspace first. The exclusive issue paths intentionally keep the root
domain package exports unchanged, so scheduling consumers use generated domain
modules and declarations. Running tests against stale `dist` files can exercise an
older schema even though the TypeScript source has changed.

```sh
pnpm build
pnpm -r exec tsc --noEmit
pnpm lint:eslint
pnpm knip
PATH=/tmp/issue135-bin:$PATH pnpm test
pnpm exec playwright test --config apps/web/app/schedules/playwright.config.ts
```

`pnpm lint` uses Trunk in this repository. When Trunk is prohibited for a task,
use `pnpm lint:eslint` and a separate Prettier check and record that substitution.
Do not silently describe an ESLint-only check as a full Trunk pass.

The memory and Postgres adapters share the same contract. A passing memory test
is useful for state-machine behavior but does not establish SQL rollback,
database uniqueness, advisory locking or cross-pool behavior. Report Postgres
availability separately from the memory result.

## Restricted local environments

Disposable Postgres tests invoke the existing repository fixture. When Docker's
disk is full, put `/tmp/issue135-bin` first on `PATH` as directed by the issue's
validation instructions. That wrapper stores database data on tmpfs. It still
requires permission to contact Docker and create the container.

HTTP integration tests and the Playwright smoke open a localhost server. A
sandbox that rejects `listen` with `EPERM` cannot run those tests. The direct
handler tests exercise the same handler using streams and captured responses,
which verifies parsing, status handling, headers and API calls without a socket.
They supplement the browser smoke; they do not establish a browser pass.

If registry DNS is unavailable, a requested formatter version may not be
fetchable even though the workspace's installed formatter works. Record both
results and the actual version used. Do not modify the lockfile merely to hide
an unavailable validation tool.

## Crash and revocation matrix

| Failure point                                 | Durable state                                    | Recovery                                                              |
| --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Before claim transaction commits              | No run or event receipt                          | Retry can claim normally                                              |
| After claim, before budget reservation        | Dispatching lease                                | Retry after lease expiry rechecks authority                           |
| After reservation, before dispatch            | Dispatching lease and reservation                | Retry reuses the run's budget operation ID                            |
| During uncertain dispatcher acceptance        | Dispatching lease; task may exist                | Active retry uses the original dispatcher idempotency key             |
| After task commits, before workflow receipt   | Task claim exists; schedule run pending          | Revocation uses read-only claim lookup and existing cancellation path |
| After workflow receipt, before run completion | Workflow receipt and task claim exist            | Active retry is idempotent; revocation locates the committed task     |
| After accepted run completion                 | Run contains task ID                             | Pause, revocation or expiry cancels that task                         |
| During cancellation                           | Accepted run remains until cancellation succeeds | Next tick retries with the same cancel key                            |
| After task terminal status                    | Terminal task and accepted run may coexist       | Reconciliation completes the run and releases concurrency             |

Pending runs with no committed task are retained as uncertain evidence when
revoked. Recovery does not call `accept` for an inactive schedule merely to
obtain a task ID. An original worker still completing its acceptance must run
the post-dispatch revocation check. A later tick checks task claims again.

Concurrency release is idempotent in the existing budget port. Cost and inference
usage already incurred are retained. Revocation does not refund spending.

## Review cautions

The offline Postgres adapter uses one advisory transaction lock and loads the
scheduler state before applying mutations. This is appropriate for the bounded
local workflow and makes the memory/database contract straightforward. It is
not a throughput claim for an internet-scale scheduling service. A future SQL
adapter can implement narrower queries and row locks behind the same port.

Cloud adapters remain typed stubs. No cloud deployment or delivery semantics are
inferred from local test success. Operator configuration is trusted and loaded
at startup. Directory membership remains fresh at fire time; local configuration
changes require a restart.

The pilot's Accepted ADR 0003 specifies observed spending rather than a hard
production cap. The runtime therefore uses observe mode. Tests explicitly use
`isolated-test-enforce` for the acceptance case where exhausted budget denies a
fire. Changing the production policy requires the ADR challenge process.
