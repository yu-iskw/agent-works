# Offline backup restore drill

The restore operation reconciles a restored governance database against a trusted
current evidence export. It is deliberately an offline step. Keep traffic,
background intake and retention scheduling disabled until the operation succeeds.
The helper does not prove that every backup copy has expired or been destroyed.

## Required inputs

- An isolated restored governance port.
- A current `GovernanceState` export from the authoritative live store, kept
  outside the restored backup.
- A nonempty drill identity, reused only for retries of that drill.
- An explicit UTC clock.
- The relevant encryption provider if read verification is required afterward.

The evidence export includes current holds, deletion requests and their complete
audit chains, tombstones and source revocation fences. Transport it through a
trusted operator channel. This helper validates structure and internal
consistency; it cannot authenticate an arbitrary JSON file's origin.

Do not use a stale backup as its own evidence authority. That would omit deletions
and releases that happened after the backup and could expose resurrected data.
The local KMS fake is process-local: restoring database bytes alone does not
restore key material. A missing key must leave reads unavailable.

## Procedure

1. Disable traffic to the isolated restore target.
2. Restore the snapshot into the isolated database or memory port.
3. Obtain the current authoritative evidence export from outside that snapshot.
4. Call `reapplyAfterRestore(restoredPort, evidence, drillId, at)`.
5. Confirm removed record identities, tombstones, source fences and audit counts.
6. Call the helper again with the same evidence and drill identity; it must report
   no newly re-purged records and append no duplicate purge evidence.
7. Verify owner fences and a surviving permitted artifact read, if keys exist.
8. Record the evidence source, drill identity, clock and verification results in
   operator evidence. Reopen traffic only after all checks succeed.

No production backup is overwritten by the test drill. The shared port contract
copies an earlier encrypted snapshot to a fresh isolated port; the Postgres
contract uses a separate schema and dedicated pool for the restored database.

## Reconciliation order

The helper clones and validates the incoming evidence before entering a write
transaction. It imports the current legal-hold command stream and request
summaries, merges immutable audit/tombstone evidence, and unions source fences.
It refreshes every live artifact's hold summary from the authoritative stream.

It then re-purges records named by tombstones, records owned by users whose
requests are `PURGED`, and unheld records from revoked sources. Registered derived
rows are removed with parents; tombstoned parent references cannot survive.
An owner fence also removes restored records that were absent from the original
per-record deletion plan.

Existing purge evidence is reused. New discoveries under a purged owner or source
fence receive minimal tombstone/purge evidence. Each actually re-purged record
also gets a `restore-repurge` event keyed by the drill and record identity. Repeating
the same drill without resurrecting more bytes changes nothing.

## Failures requiring operator reconciliation

| Failure                                                  | Safe outcome                                                |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| Missing or malformed audit transition                    | Roll back; keep target offline                              |
| Same immutable evidence identity with different content  | Roll back; reconcile evidence source                        |
| Evidence would remove a known hold command               | Roll back; obtain current evidence                          |
| Tombstoned/deleted record has a conflicting current hold | Roll back; reconcile legal evidence                         |
| Revoked source remains under an active hold              | Keep bytes, preserve fence and deny ordinary reads          |
| Missing encryption key                                   | Reads fail closed; recover approved key material separately |
| Database transaction failure                             | Roll back; retry after restoring availability               |

A successful SQL restore is insufficient by itself. The safety boundary is the
completed governance reconciliation plus verified identity, ACL and key inputs
before the service accepts traffic.
