-- Offline Phase 4 evidence. No endpoint, pricing, identity grant, or production flag is enabled.
create table model_inference_records (
 sequence bigint generated always as identity primary key,
 inference_id text not null unique,
 task_id text not null,
 trace_id text not null,
 model_id text not null check (length(model_id) > 0),
 model_version text not null check (length(model_version) > 0),
 region text not null check (length(region) > 0),
 governance_zone text not null check (length(governance_zone) > 0),
 status text not null check (status in ('started', 'succeeded', 'failed')),
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 check (payload->>'inferenceId' = inference_id),
 check (payload->>'status' = status),
 check (payload->'model'->>'modelId' = model_id),
 check (payload->'model'->>'version' = model_version),
 check (payload->'model'->>'region' = region)
);
create index model_inferences_task on model_inference_records (task_id, sequence);
create index model_inferences_trace on model_inference_records (trace_id, sequence);
create table model_routing_audits (
 sequence bigint generated always as identity primary key,
 event_id text not null unique,
 task_id text not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
create index model_routing_audits_task on model_routing_audits (task_id, sequence);
create table delegation_edges (
 sequence bigint generated always as identity primary key,
 child_task_id text not null unique,
 parent_task_id text not null,
 root_task_id text not null,
 trace_id text not null,
 depth integer not null check (depth > 0),
 delegated_authority_hash text not null check (delegated_authority_hash ~ '^[a-f0-9]{64}$'),
 budget_share jsonb not null check (jsonb_typeof(budget_share) = 'object'),
 state text not null check (state in ('pending', 'verified', 'rejected', 'failed')),
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 check (child_task_id <> parent_task_id and child_task_id <> root_task_id),
 check (payload->>'childTaskId' = child_task_id),
 check (payload->>'state' = state),
 check (state <> 'verified' or (payload->>'resultDigest' is not null and payload->>'verifierRef' is not null))
);
create index delegation_edges_parent on delegation_edges (parent_task_id, sequence);
create index delegation_edges_root on delegation_edges (root_task_id, sequence);
create index delegation_edges_trace on delegation_edges (trace_id, sequence);
create table delegation_audits (
 sequence bigint generated always as identity primary key,
 event_id text not null unique,
 parent_task_id text not null,
 payload jsonb not null check (jsonb_typeof(payload) = 'object')
);
create index delegation_audits_parent on delegation_audits (parent_task_id, sequence);
