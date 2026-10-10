create table ask_replays (
  request_id text primary key,
  initiator_subject text not null,
  request_digest_sha256 text not null check (request_digest_sha256 ~ '^[a-f0-9]{64}$'),
  response_status integer,
  response_body text,
  check (
    (response_status is null and response_body is null)
    or (response_status is not null and response_body is not null)
  )
);
