-- AGT-01 versioned DAG execution. Additive and idempotent.
--  retry_not_before: earliest next attempt of a node in retry_wait (a queued row with a future time).
--  owner_token:      fencing token of the one worker that owns a running node; a writer that does not
--                    hold it cannot settle the node.
--  run_after:        a job is not claimable before this time (retry backoff).
alter table tw_assignments add column if not exists retry_not_before timestamptz;
alter table tw_assignments add column if not exists owner_token uuid;
alter table tw_jobs add column if not exists run_after timestamptz;
-- One live node per key in a task's graph: a rerun supersedes the old node, it never shares the key.
create unique index if not exists tw_assignments_live_key on tw_assignments (task_id, key)
  where status <> 'superseded';
