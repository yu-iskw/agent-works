import { createSealer, loadKey } from '@agent-works/domain/sealer';
import postgres from 'postgres';

const SCHEMA = `
create table if not exists m1_sessions (
  id_sha256 text primary key,
  sub text not null,
  email text not null,
  name text not null,
  idp text not null check (idp in ('google', 'local-test')),
  csrf text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create table if not exists m1_login_states (
  state text primary key,
  nonce text not null,
  code_verifier text not null,
  return_to text not null,
  expires_at timestamptz not null
);
create table if not exists m1_refresh_tokens (
  email text primary key,
  sub text not null,
  sealed text not null,
  updated_at timestamptz not null
);
create table if not exists m1_preferences (
  sub text not null,
  scope text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null,
  primary key (sub, scope, key)
);
create table if not exists m1_web_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  sub text,
  action text not null,
  outcome text not null
);
`;

export type WebDb = Awaited<ReturnType<typeof openWebDb>>;

export async function openWebDb(url: string, keyDir: string) {
  const sql = postgres(url, { onnotice: () => undefined });
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(8018)`;
    await tx.unsafe(SCHEMA);
  });
  const sealer = createSealer(loadKey(keyDir, 'web-token.key'), 'aw-m1:web:refresh');
  return {
    sql,
    async audit(sub: string | null, action: string, outcome: string) {
      await sql`insert into m1_web_audit (sub, action, outcome) values (${sub}, ${action}, ${outcome})`;
    },
    async storeRefresh(email: string, sub: string, token: string) {
      await sql`
        insert into m1_refresh_tokens (email, sub, sealed, updated_at) values (${email}, ${sub}, ${sealer.seal(token)}, now())
        on conflict (email) do update set sub = excluded.sub, sealed = excluded.sealed, updated_at = excluded.updated_at
      `;
    },
    async readRefresh(email: string): Promise<string | undefined> {
      const rows = await sql<
        { sealed: string }[]
      >`select sealed from m1_refresh_tokens where email = ${email}`;
      const row = rows.at(0);
      return row === undefined ? undefined : sealer.open(row.sealed);
    },
  };
}
