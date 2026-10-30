-- Plan dependencies for assignments: the plan keys an assignment waits for. It gets no job until
-- every one of them has succeeded. Idempotent, because some local databases had it from an earlier
-- draft of 0018.
alter table tw_assignments add column if not exists depends_on jsonb not null default '[]'::jsonb;
