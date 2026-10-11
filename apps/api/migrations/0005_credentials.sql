create table oauth_grants (
  state text primary key,
  provider text not null,
  subject text not null,
  code_challenge text not null,
  scope text not null
);

create table oauth_connections (
  subject text not null,
  provider text not null,
  scope text not null,
  status text not null,
  expires_at timestamptz not null,
  token_ref text not null,
  primary key (subject, provider),
  check (status in ('active', 'revoked', 'expired'))
);
