-- Offline governance evidence and encrypted data. Managed services stay gated by #107.
-- Strictly validate the envelope projection at the SQL boundary as well as in TypeScript.
-- COALESCE is essential: a CHECK with a NULL result otherwise accepts missing JSON keys.
create function governance_valid_envelope(value jsonb) returns boolean
  language sql immutable parallel safe as $$
  select coalesce(
    jsonb_typeof(value) = 'object'
    and value ?& array['version','algorithm','keyId','wrappedKey','wrappingNonce','wrappingTag','nonce','tag','ciphertext','aadHash']
    and value->>'version' = '1'
    and value->>'algorithm' = 'AES-256-GCM'
    and length(value->>'keyId') between 1 and 512
    and value->>'aadHash' ~ '^[a-f0-9]{64}$'
    and value->>'wrappedKey' ~ '^[A-Za-z0-9+/]+={0,2}$'
    and value->>'wrappingNonce' ~ '^[A-Za-z0-9+/]+={0,2}$'
    and value->>'wrappingTag' ~ '^[A-Za-z0-9+/]+={0,2}$'
    and value->>'nonce' ~ '^[A-Za-z0-9+/]+={0,2}$'
    and value->>'tag' ~ '^[A-Za-z0-9+/]+={0,2}$'
    and value->>'ciphertext' ~ '^[A-Za-z0-9+/]*={0,2}$', false);
$$;

create table governance_retention_policies (
  id text primary key,
  payload jsonb not null,
  ttl_seconds integer generated always as ((payload->>'ttlSeconds')::integer) stored not null,
  check (ttl_seconds > 0 and ttl_seconds <= 315360000),
  check (jsonb_typeof(payload) = 'object' and payload ? 'id' and payload->>'id' = id)
);
create table governance_artifacts (
  id text primary key,
  payload jsonb not null,
  owner_subject text generated always as (payload->'record'->'provenance'->>'owner') stored not null,
  source_id text generated always as (payload->'record'->'provenance'->>'sourceId') stored not null,
  classification text generated always as (payload->'record'->>'classification') stored not null,
  retention_class text generated always as (payload->'record'->>'retentionClass') stored not null,
  expires_at text generated always as (payload->'record'->>'expiresAt') stored not null,
  foreign key (retention_class) references governance_retention_policies(id),
  check (payload->'record' ?& array['schemaVersion','id','kind','taskId','classification','provenance','retentionClass','createdAt','expiresAt','legalHold','canonicalHash']),
  check (payload->'record'->>'id' = id),
  check (payload->'record'->>'schemaVersion' = '1'),
  check (payload->'record'->>'kind' in ('artifact','task-output')),
  check (payload->'record'->'provenance' ?& array['owner','origin','region','sourceId','aclEvidenceRef']),
  check (payload ?& array['record','envelope']),
  check (classification in ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  check (governance_valid_envelope(payload->'envelope')),
  check (payload->'record'->>'canonicalHash' ~ '^[a-f0-9]{64}$')
);
create index governance_artifacts_owner on governance_artifacts(owner_subject, id);
create index governance_artifacts_source on governance_artifacts(source_id, id);
create index governance_artifacts_expiry on governance_artifacts(expires_at, id);
create table governance_derived (
  id text primary key,
  payload jsonb not null,
  parent_id text generated always as (payload->>'parentId') stored not null,
  kind text generated always as (payload->>'kind') stored not null,
  foreign key (parent_id) references governance_artifacts(id) on delete cascade,
  check (jsonb_typeof(payload) = 'object' and payload ? 'id' and payload->>'id' = id),
  check (kind in ('index','cache','task-event','task-output')),
  check (governance_valid_envelope(payload->'envelope'))
);
create index governance_derived_parent on governance_derived(parent_id, id);
create table governance_legal_holds (
  id text primary key,
  payload jsonb not null,
  sequence bigint generated always as ((payload->>'sequence')::bigint) stored not null unique,
  target_kind text generated always as (payload->'target'->>'kind') stored not null,
  target_id text generated always as (payload->'target'->>'id') stored not null,
  check (payload ?& array['commandId','target','action','reasonRef','actor','occurredAt','sequence']),
  check (sequence > 0),
  check (payload->>'commandId' = id),
  check (payload->>'action' in ('set','release')),
  check (target_kind in ('record','owner','source'))
);
create index governance_holds_target on governance_legal_holds(target_kind, target_id, sequence desc);
create table governance_deletion_requests (
  id text primary key,
  payload jsonb not null,
  owner_subject text generated always as (payload->>'subject') stored not null,
  state text generated always as (payload->>'state') stored not null,
  revision bigint generated always as ((payload->>'revision')::bigint) stored not null,
  check (payload ?& array['requestId','subject','state','actor','reasonRef','requestedAt','updatedAt','rejectionRef','revision']),
  check ((state = 'REJECTED') = (payload->>'rejectionRef' is not null)),
  check (payload->>'requestId' = id),
  check (state in ('REQUESTED','HELD','SCHEDULED','PURGED','REJECTED')),
  check (revision > 0)
);
create index governance_requests_owner on governance_deletion_requests(owner_subject, id);
create index governance_requests_pending on governance_deletion_requests(state, id)
  where state in ('REQUESTED','HELD','SCHEDULED');
create table governance_tombstones (
  id text primary key,
  payload jsonb not null,
  check (payload ?& array['recordId','ownerHash','sourceHash','canonicalHash','requestId','purgedAt','reason']),
  check (payload->>'recordId' = id),
  check (payload->>'ownerHash' ~ '^[a-f0-9]{64}$'),
  check (payload->>'sourceHash' ~ '^[a-f0-9]{64}$')
);
create table governance_audit (
  id text primary key,
  payload jsonb not null,
  check (payload ?& array['eventId','type','occurredAt','actorHash','targetHash','requestId','state','redactionMarker']),
  check (payload->>'eventId' = id),
  check (payload->>'redactionMarker' = 'governance-tombstone-v1'),
  check (payload->>'actorHash' ~ '^[a-f0-9]{64}$'),
  check (payload->>'targetHash' ~ '^[a-f0-9]{64}$')
);
create table governance_revoked_sources (
  id text primary key,
  payload jsonb not null,
  check (jsonb_typeof(payload) = 'object' and payload ? 'id' and payload->>'id' = id)
);
create function governance_reject_evidence_rewrite() returns trigger language plpgsql as $$
begin
  raise exception 'governance evidence is append-only';
end;
$$;
create trigger governance_policies_immutable before update or delete or truncate
  on governance_retention_policies for each statement execute function governance_reject_evidence_rewrite();
create trigger governance_holds_immutable before update or delete or truncate
  on governance_legal_holds for each statement execute function governance_reject_evidence_rewrite();
create trigger governance_tombstones_immutable before update or delete or truncate
  on governance_tombstones for each statement execute function governance_reject_evidence_rewrite();
create trigger governance_audit_immutable before update or delete or truncate
  on governance_audit for each statement execute function governance_reject_evidence_rewrite();
create trigger governance_revocations_immutable before update or delete or truncate
  on governance_revoked_sources for each statement execute function governance_reject_evidence_rewrite();

-- Request updates may summarize several audited transitions in one transaction.
-- The adapter validates each transition; the database fences terminal states and identity.
create function governance_check_request_update() returns trigger language plpgsql as $$
begin
  if old.payload->>'state' in ('PURGED','REJECTED') and new.payload <> old.payload then
    raise exception 'terminal deletion request is immutable';
  end if;
  if new.id is distinct from old.id
    or new.payload->>'requestId' is distinct from old.payload->>'requestId'
    or new.payload->>'subject' is distinct from old.payload->>'subject'
    or new.payload->>'actor' is distinct from old.payload->>'actor'
    or new.payload->>'reasonRef' is distinct from old.payload->>'reasonRef'
    or new.payload->>'requestedAt' is distinct from old.payload->>'requestedAt' then
    raise exception 'deletion request identity is immutable';
  end if;
  if new.payload <> old.payload and (new.payload->>'revision')::bigint <= (old.payload->>'revision')::bigint then
    raise exception 'deletion request revision must advance';
  end if;
  if new.payload->>'state' = 'REQUESTED' and old.payload->>'state' <> 'REQUESTED' then
    raise exception 'deletion request cannot return to REQUESTED';
  end if;
  return new;
end;
$$;
create trigger governance_request_transition before update on governance_deletion_requests
  for each row execute function governance_check_request_update();
create trigger governance_requests_no_delete before delete or truncate
  on governance_deletion_requests for each statement execute function governance_reject_evidence_rewrite();
