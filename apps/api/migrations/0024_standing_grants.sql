-- Standing grants for this segment (AGT-03). The segment database is the workspace, so there is
-- no workspace column. A grant row is immutable except for the one-way revocation columns, and
-- the audit table is append-only; both rules are enforced by triggers. Every statement is
-- additive and re-runnable.

create table if not exists tw_standing_grants (
  grant_id text primary key,
  issuer text not null,
  -- The human on whose authority the chain rests; the same value down the whole chain.
  sponsor text not null,
  grantee_bot_id text not null,
  grantee_bot_version integer not null check (grantee_bot_version > 0),
  permissions jsonb not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  parent_grant_id text references tw_standing_grants (grant_id),
  depth integer not null check (depth >= 0),
  max_depth integer not null check (max_depth >= 0),
  schedule jsonb not null,
  limits jsonb not null,
  policy_revision text not null,
  audit_ref text not null,
  check (expires_at > issued_at),
  check (depth <= max_depth),
  check ((parent_grant_id is null) = (depth = 0)),
  check ((revoked_at is null) = (revoked_by is null))
);

create index if not exists tw_standing_grants_sponsor on tw_standing_grants (sponsor);
create index if not exists tw_standing_grants_parent on tw_standing_grants (parent_grant_id);

create table if not exists tw_standing_grant_audit (
  seq bigserial primary key,
  -- No foreign key: a denied issuance has no grant row but still leaves a record.
  grant_id text not null,
  event text not null check (
    event in ('issued', 'issue_denied', 'revoked', 'revoked_by_ancestor', 'reviewed')
  ),
  actor text not null,
  occurred_at timestamptz not null,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists tw_standing_grant_audit_grant on tw_standing_grant_audit (grant_id, seq);

create or replace function tw_standing_grants_guard() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'standing grants are never deleted';
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked standing grant is final';
  end if;
  if (old.grant_id, old.issuer, old.sponsor, old.grantee_bot_id, old.grantee_bot_version,
      old.permissions, old.issued_at, old.expires_at, old.parent_grant_id, old.depth,
      old.max_depth, old.schedule, old.limits, old.policy_revision, old.audit_ref)
    is distinct from
     (new.grant_id, new.issuer, new.sponsor, new.grantee_bot_id, new.grantee_bot_version,
      new.permissions, new.issued_at, new.expires_at, new.parent_grant_id, new.depth,
      new.max_depth, new.schedule, new.limits, new.policy_revision, new.audit_ref) then
    raise exception 'standing grants are immutable apart from revocation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists tw_standing_grants_guard on tw_standing_grants;
create trigger tw_standing_grants_guard
  before update or delete on tw_standing_grants
  for each row execute function tw_standing_grants_guard();

create or replace function tw_standing_grant_audit_guard() returns trigger as $$
begin
  raise exception 'standing grant audit is append-only';
end;
$$ language plpgsql;

drop trigger if exists tw_standing_grant_audit_guard on tw_standing_grant_audit;
create trigger tw_standing_grant_audit_guard
  before update or delete on tw_standing_grant_audit
  for each row execute function tw_standing_grant_audit_guard();
