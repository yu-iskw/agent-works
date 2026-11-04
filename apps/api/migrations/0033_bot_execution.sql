alter table tw_bot_runs add column if not exists result_text text;
alter table tw_bot_runs add column if not exists deadline_at timestamptz;
create index if not exists tw_bot_runs_grant on tw_bot_runs (grant_id);
alter table tw_bot_steps add column if not exists cost jsonb;
alter table tw_bots add column if not exists owner_email text;
alter table tw_bot_runs add column if not exists cancel_requested_at timestamptz;
alter table tw_bot_steps add column if not exists cost_history jsonb not null default '[]'::jsonb;
