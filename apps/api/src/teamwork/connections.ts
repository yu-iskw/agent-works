import { createHash, randomBytes } from 'node:crypto';

import { audit, Conflict } from './context.js';
import { SourceError } from './sources/port.js';

import type { Deps, Member } from './context.js';
import type { TokenSource } from './sources/port.js';

export type Provider = 'google' | 'github';

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/bigquery.readonly',
] as const;
const REQUIRED_GOOGLE = GOOGLE_SCOPES.filter((scope) => scope.startsWith('https://'));

const STATE_TTL_MS = 10 * 60 * 1000;

export type ConnectionView = {
  readonly provider: Provider;
  readonly status: 'active' | 'revoked' | 'error' | 'not_connected';
  readonly account: string | null;
  readonly scopes: readonly string[];
  readonly connectedAt: string | null;
  readonly errorCode: string | null;
  readonly configured: boolean;
};

type Row = {
  owner_sub: string;
  provider: Provider;
  account: string;
  scopes: string[];
  sealed_access: string;
  sealed_refresh: string | null;
  access_expires_at: Date | null;
  status: 'active' | 'revoked' | 'error';
  error_code: string | null;
  connected_at: Date;
};

const b64url = (buffer: Buffer) => buffer.toString('base64url');

function redirectUri(deps: Deps, provider: Provider): string {
  return `${deps.config.publicUrl}/connections/${provider}/callback`;
}

function client(deps: Deps, provider: Provider) {
  const found = provider === 'google' ? deps.config.google : deps.config.github;
  if (found === undefined) throw new Conflict('provider_not_configured', 503);
  return found;
}

/** Starts a connection: a single-use state bound to this member and segment, plus a PKCE verifier. */
export async function startConnection(
  deps: Deps,
  member: Member,
  provider: Provider,
): Promise<string> {
  const { clientId } = client(deps, provider);
  const state = `${deps.config.segment}.${b64url(randomBytes(24))}`;
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  await deps.sql`
    insert into tw_oauth_states (state, owner_sub, provider, code_verifier, expires_at)
    values (${state}, ${member.sub}, ${provider}, ${verifier}, ${new Date(deps.now().getTime() + STATE_TTL_MS)})
  `;
  const params =
    provider === 'google'
      ? new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri(deps, provider),
          response_type: 'code',
          scope: GOOGLE_SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          login_hint: member.email,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
      : new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri(deps, provider),
          scope: '',
          allow_signup: 'false',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
  const base =
    provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://github.com/login/oauth/authorize';
  return `${base}?${params.toString()}`;
}

function decodeClaims(idToken: string): Record<string, unknown> {
  const part = idToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

type GoogleToken = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
};

type Exchanged = {
  readonly account: string;
  readonly scopes: string[];
  readonly access: string;
  readonly refresh: string | null;
  readonly expiresAt: Date | null;
};

const EXCHANGE_FAILED = 'oauth_exchange_failed';
const FORM_URLENCODED = 'application/x-www-form-urlencoded';
const TOKEN_TIMEOUT_MS = 15_000;

async function exchangeGoogle(
  deps: Deps,
  member: Member,
  code: string,
  verifier: string,
): Promise<Exchanged> {
  const { clientId, clientSecret } = client(deps, 'google');
  const response = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': FORM_URLENCODED },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri(deps, 'google'),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as GoogleToken;
  if (!response.ok || body.access_token === undefined || body.id_token === undefined)
    throw new Conflict(EXCHANGE_FAILED, 502);
  // The ID token came straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7).
  const claims = decodeClaims(body.id_token);
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (claims.aud !== clientId || claims.email_verified !== true || email !== member.email) {
    await audit(deps, deps.sql, {
      ownerSub: member.sub,
      action: 'connect.google',
      outcome: 'account_mismatch',
    });
    throw new Conflict('connection_account_mismatch', 403);
  }
  return {
    account: email,
    scopes: (body.scope ?? '').split(' ').filter(Boolean),
    access: body.access_token,
    refresh: body.refresh_token ?? null,
    expiresAt: new Date(deps.now().getTime() + (body.expires_in ?? 3600) * 1000),
  };
}

async function exchangeGithub(deps: Deps, code: string, verifier: string): Promise<Exchanged> {
  const { clientId, clientSecret } = client(deps, 'github');
  const response = await deps.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri(deps, 'github'),
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    scope?: string;
  };
  if (!response.ok || body.access_token === undefined) throw new Conflict(EXCHANGE_FAILED, 502);
  const user = await deps.fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${body.access_token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-works-m1',
    },
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  const profile = (await user.json().catch(() => ({}))) as { login?: string };
  if (!user.ok || profile.login === undefined) throw new Conflict(EXCHANGE_FAILED, 502);
  return {
    account: profile.login,
    scopes: (body.scope ?? '').split(',').filter(Boolean),
    access: body.access_token,
    refresh: null,
    expiresAt: null,
  };
}

/**
 * Completes a connection. The state must be unused, unexpired and issued to this same member;
 * the Google account that consented must be the member's own signed-in account.
 */
export async function completeConnection(
  deps: Deps,
  member: Member,
  provider: Provider,
  input: { readonly code: string; readonly state: string },
): Promise<ConnectionView> {
  client(deps, provider);
  const claimed = await deps.sql<{ code_verifier: string }[]>`
    update tw_oauth_states set used_at = ${deps.now()}
    where state = ${input.state} and owner_sub = ${member.sub} and provider = ${provider}
      and used_at is null and expires_at > ${deps.now()}
    returning code_verifier
  `;
  const verifier = claimed.at(0)?.code_verifier;
  if (verifier === undefined) {
    await audit(deps, deps.sql, {
      ownerSub: member.sub,
      action: `connect.${provider}`,
      outcome: 'bad_state',
    });
    throw new Conflict('oauth_state_invalid', 400);
  }
  const { account, scopes, access, refresh, expiresAt } =
    provider === 'google'
      ? await exchangeGoogle(deps, member, input.code, verifier)
      : await exchangeGithub(deps, input.code, verifier);
  const missing =
    provider === 'google' ? REQUIRED_GOOGLE.filter((scope) => !scopes.includes(scope)) : [];
  const status = missing.length === 0 ? 'active' : 'error';
  await deps.sql`
    insert into tw_connections (owner_sub, provider, account, scopes, sealed_access, sealed_refresh,
      access_expires_at, status, error_code, connected_at, updated_at)
    values (${member.sub}, ${provider}, ${account}, ${deps.sql.json(scopes)}, ${deps.sealer.seal(access)},
      ${refresh === null ? null : deps.sealer.seal(refresh)}, ${expiresAt}, ${status},
      ${missing.length === 0 ? null : 'scopes_missing'}, ${deps.now()}, ${deps.now()})
    on conflict (owner_sub, provider) do update set account = excluded.account, scopes = excluded.scopes,
      sealed_access = excluded.sealed_access,
      sealed_refresh = coalesce(excluded.sealed_refresh, tw_connections.sealed_refresh),
      access_expires_at = excluded.access_expires_at, status = excluded.status,
      error_code = excluded.error_code, connected_at = excluded.connected_at, updated_at = excluded.updated_at
  `;
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    action: `connect.${provider}`,
    outcome: status,
    detail: { scopes: scopes.length, missing: missing.length },
  });
  return (await connections(deps, member)).find(
    (view) => view.provider === provider,
  ) as ConnectionView;
}

export async function connections(deps: Deps, member: Member): Promise<readonly ConnectionView[]> {
  const rows = await deps.sql<Row[]>`select * from tw_connections where owner_sub = ${member.sub}`;
  return (['google', 'github'] as const).map((provider) => {
    const row = rows.find((item) => item.provider === provider);
    const configured =
      (provider === 'google' ? deps.config.google : deps.config.github) !== undefined;
    if (row === undefined)
      return {
        provider,
        status: 'not_connected',
        account: null,
        scopes: [],
        connectedAt: null,
        errorCode: null,
        configured,
      };
    return {
      provider,
      status: row.status,
      account: row.account,
      scopes: row.scopes,
      connectedAt: row.connected_at.toISOString(),
      errorCode: row.error_code,
      configured,
    };
  });
}

export async function connectedProviders(
  deps: Deps,
  ownerSub: string,
): Promise<ReadonlySet<Provider>> {
  if (deps.config.sourceMode === 'fixture') return new Set(['google', 'github']);
  const rows = await deps.sql<{ provider: Provider }[]>`
    select provider from tw_connections where owner_sub = ${ownerSub} and status = 'active'
  `;
  return new Set(rows.map((row) => row.provider));
}

async function refreshGoogle(deps: Deps, row: Row): Promise<string> {
  const { clientId, clientSecret } = client(deps, 'google');
  if (row.sealed_refresh === null) throw new SourceError('token_expired');
  const response = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': FORM_URLENCODED },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: deps.sealer.open(row.sealed_refresh),
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as GoogleToken;
  if (!response.ok || body.access_token === undefined) {
    await deps.sql`
      update tw_connections set status = 'error', error_code = 'refresh_failed', updated_at = ${deps.now()}
      where owner_sub = ${row.owner_sub} and provider = 'google'
    `;
    throw new SourceError('token_expired');
  }
  await deps.sql`
    update tw_connections set sealed_access = ${deps.sealer.seal(body.access_token)},
      access_expires_at = ${new Date(deps.now().getTime() + (body.expires_in ?? 3600) * 1000)},
      updated_at = ${deps.now()}
    where owner_sub = ${row.owner_sub} and provider = 'google'
  `;
  return body.access_token;
}

/** Access tokens for one member in this segment only; never another member's, never ADC. */
export function tokenSource(deps: Deps, ownerSub: string): TokenSource {
  return async (provider) => {
    if (deps.config.sourceMode === 'fixture') return 'fixture';
    const rows = await deps.sql<Row[]>`
      select * from tw_connections where owner_sub = ${ownerSub} and provider = ${provider}
    `;
    const row = rows.at(0);
    if (row === undefined) throw new SourceError('not_connected');
    if (row.status !== 'active') throw new SourceError('token_expired');
    const soon = deps.now().getTime() + 60_000;
    if (provider === 'google' && (row.access_expires_at?.getTime() ?? 0) < soon)
      return refreshGoogle(deps, row);
    return deps.sealer.open(row.sealed_access);
  };
}

/** Revokes at the provider where possible, then deletes the binding. Running work loses access. */
export async function disconnect(deps: Deps, member: Member, provider: Provider): Promise<void> {
  const rows = await deps.sql<Row[]>`
    select * from tw_connections where owner_sub = ${member.sub} and provider = ${provider}
  `;
  const row = rows.at(0);
  if (row === undefined) return;
  let revoked = false;
  try {
    if (provider === 'google') {
      const token =
        row.sealed_refresh === null
          ? deps.sealer.open(row.sealed_access)
          : deps.sealer.open(row.sealed_refresh);
      const response = await deps.fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': FORM_URLENCODED },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      revoked = response.ok;
    } else {
      const { clientId, clientSecret } = client(deps, 'github');
      const response = await deps.fetch(`https://api.github.com/applications/${clientId}/grant`, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'agent-works-m1',
        },
        body: JSON.stringify({ access_token: deps.sealer.open(row.sealed_access) }),
        signal: AbortSignal.timeout(10_000),
      });
      revoked = response.status === 204;
    }
  } catch {
    revoked = false;
  }
  await deps.sql`delete from tw_connections where owner_sub = ${member.sub} and provider = ${provider}`;
  await audit(deps, deps.sql, {
    ownerSub: member.sub,
    action: `disconnect.${provider}`,
    outcome: revoked ? 'revoked' : 'deleted_locally',
  });
}
