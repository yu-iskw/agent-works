# Memory lifecycle

## State transitions

| Event                       | Active unheld item                   | Held item                   |
| --------------------------- | ------------------------------------ | --------------------------- |
| User consent off            | Purge current and history            | Seal and retain             |
| TTL expires                 | Omit recall; sweeper purges          | Omit recall; retain         |
| Own delete                  | Purge with revision check            | Return conflict             |
| Governance deletion         | Purge; acknowledge fan-out           | Seal; request remains HELD  |
| Source revocation           | Purge; retain revocation evidence    | Seal and retain             |
| Hold released after sealing | Already purged                       | Purge preserved content     |
| Restore replay              | Apply current consent and tombstones | Apply current hold evidence |

An active item has one current revision and append-only historical revisions.
Its original expiry and provenance do not change during a text edit. Revision
commands must provide the current revision. Concurrent commands serialize, and
one winner increments the revision while stale commands fail.

Sealed means unavailable for personalization. Re-enabling consent does not
reactivate sealed rows. Hold release completes deletion of sealed content.
A held row may remain physically present after opt-out or source revocation;
this preservation is visible in the lifecycle contract and does not imply
continued recall permission.

## TTL

A proposal has a TTL from 60 seconds through 31,536,000 seconds. The expiry is
computed from the trusted clock at write time. Recall requires current time to
be strictly earlier than expiry. At the exact boundary the item is omitted.

The sweep scans items, physically erases expired unheld current/history rows,
and writes minimal expiry evidence. Running it again is idempotent. Expired held
items remain physically available to authorized governance operations but never
appear in personalization recall. Release followed by sweep removes them.

## Opt-out

Opt-out disables the consent before returning the command result. Every unheld
item belonging to that tenant and owner is physically purged across all agents.
All historical text for each purged item is removed too. Content-free audit and
tombstone evidence remains for restore replay.

Held rows become sealed. Consent restoration does not resurrect them. Once the
hold is released, sealed rows are purged. Deleted item IDs cannot be proposed
again; a later new preference needs a fresh identifier and current consent.

## Governance integration

`governUserMemory` registers one deletion fan-out on the shared governance port.
It wraps normal memory transactions in the governance transaction lock so hold
changes and deletion processing coordinate with memory writes. Its fan-out uses
the raw memory store to avoid recursively entering that same lock.

On every wrapped transaction, current governance hold commands are projected
onto matching memory record, owner, and source targets. The latest command per
target wins. Any still-active applicable hold preserves the row. Current
revocations and HELD/SCHEDULED/PURGED deletion requests are also applied.

Deletion processing waits for the registered memory fan-out before marking the
request purged. If any memory rows are held, the governance request remains HELD
even if it has no artifact rows. Releasing the hold and processing again purges
memory history and allows the request to complete.

The stores are separate transactional ports. A memory purge can commit before a
later governance commit failure. Processing is intentionally retry-safe: already
purged memory stays purged, and a retry completes governance evidence. A failure
is never treated as successful deletion processing. This local composition does
not claim distributed atomicity across cloud services.

## Restore drills

Keep traffic closed while restoring. Take current deletion evidence from the
live memory store outside the backup. Restore the stale payload state, then run
`restoreUserMemory` or `runtime.restore` with the current evidence and clock.

Replay replaces backed-up consent with current consent, merges revocations and
tombstones, and purges any restored row that is tombstoned, opted out, revoked,
or expired. Current hold evidence may seal a row instead. A live tombstone that
conflicts with a current legal hold is rejected for operator reconciliation.

The governance wrapper separately applies current governance deletion requests
and hold commands before allowing ordinary memory operations. The restore test
covers a stale raw memory backup served through that current governance wrapper.

Restore replay removes historical payloads with current rows. Repeating the drill
cannot reintroduce erased text or multiply an existing tombstone. Do not use a
backed-up evidence copy as the current authority for the drill.
