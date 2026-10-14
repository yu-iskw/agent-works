# Offline scheduled tasks and verified events

Issue #140 implements RFC-001 §7.5 using the existing task dispatcher and local
workflow engine. Migration `0013_schedules.sql` persists schedules, runs, trigger
registrations, received events and an append-only audit trail. Cloud Scheduler,
Pub/Sub and Eventarc are typed offline planning stubs. They make no cloud calls.

A schedule has an authenticated human sponsor, purpose, consent reference,
pinned skill version, maximum privilege ceiling, timezone, allowed window,
expiry and cancellation policy. Creation checks that every dimension of the
ceiling is within the sponsor's current authority. Every fire repeats that check,
checks the consent grant, enforces suspensions, and reserves budget before
calling `DispatchPort.accept`.

- [Operational behavior and recovery](operations.md)
- [API, CLI and local configuration](interfaces.md)
- [Event signatures and adversarial boundaries](events.md)
- [Verification evidence and crash recovery](verification.md)

## Local configuration

The API reads `AW_SCHEDULE_CONFIG` as a path to a trusted operator-owned JSON
file. Its strict schema contains `authorities`, `consents` and `keys`. No file
means empty registries: list works, but creation has no standing authority or
consent grant. The server does not invent grants from form fields or event text.
Configuration is read at startup; restart after changing the file. Authority is
also checked against a fresh directory snapshot at every fire. Tests use mutable
in-memory registries to exercise revocation without restarting the server.

Consent grants bind the reference, subject, canonical schedule digest and expiry.
Compute the digest with `scheduleHash` from the domain schedule module after
building the domain package. Changes to purpose, skill, task input, privilege,
timing or any other specification field require a different matching grant.

The runtime observes budgets, consistent with Accepted ADR 0003. Isolated tests
use the existing `isolated-test-enforce` mode to verify budget exhaustion denies
scheduled fire. These placeholder limits are not an approved production spending
cap. Scheduler reservations release concurrency when a linked task reaches a
terminal status or is cancelled; incurred cost and inference steps remain.

## Verification

Build before running the new tests: under the exclusive issue paths, API and web
consume the new domain modules through their generated `dist/*.js` declarations.
No root domain export map is changed.

```sh
pnpm build
PATH=/tmp/issue135-bin:$PATH pnpm test
pnpm lint:eslint
pnpm knip
pnpm exec playwright test --config apps/web/app/schedules/playwright.config.ts
```

The Playwright smoke server runs locally with a fake API. It verifies list,
privilege preview, create, pause and resume without Docker or live cloud services.
Postgres contracts skip explicitly when disposable Postgres is unavailable;
they do not substitute memory results for database evidence.
