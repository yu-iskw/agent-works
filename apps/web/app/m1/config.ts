import { csvList, readEnvFile } from '@agent-works/domain/env-file';

import type { IdentityMode } from '@agent-works/domain/teamwork';

type Env = Readonly<Record<string, string | undefined>>;

export type Segment = { readonly id: string; readonly name: string; readonly url: string };

export type WebConfig = {
  readonly publicUrl: string;
  readonly identity: IdentityMode;
  readonly segments: readonly Segment[];
  readonly databaseUrl: string;
  readonly keyDir: string;
  readonly google: { readonly clientId: string; readonly clientSecret: string } | undefined;
  /** Segment id to member emails; the segment APIs enforce membership again on every call. */
  readonly members: ReadonlyMap<string, ReadonlySet<string>>;
  /** Present only when AW_E2E_MODE=1 and a secret is configured; otherwise the endpoint is off. */
  readonly e2eSecret: string | undefined;
  readonly missing: readonly string[];
};

export const LOCAL_TEST_MEMBERS = ['alice@local.test', 'bob@local.test'] as const;
const LOCAL_TEST: IdentityMode = 'local-test';

/**
 * Parses `id=http://host:port|Name,...`. Every backend host must be on the allowlist and every id
 * well formed, so the browser can only ever choose among these fixed backends by id.
 */
export function parseSegments(
  raw: string | undefined,
  allowedHosts: readonly string[],
): readonly Segment[] {
  const segments = csvList(raw).map((entry) => {
    const match = /^([a-z][a-z0-9-]{1,30})=(https?:\/\/[^|]+)\|(.+)$/.exec(entry);
    if (match === null) throw new Error(`invalid AW_SEGMENTS entry: ${entry}`);
    const [, id = '', url = '', name = ''] = match;
    const host = new URL(url).hostname;
    if (!allowedHosts.includes(host)) throw new Error(`segment backend host not allowed: ${host}`);
    return { id, url: url.replace(/\/$/, ''), name: name.trim() };
  });
  if (new Set(segments.map((s) => s.id)).size !== segments.length)
    throw new Error('duplicate segment id');
  return segments;
}

type Lookup = (key: string) => string | undefined;

function membersOf(
  segments: readonly Segment[],
  identity: IdentityMode,
  get: Lookup,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    segments.map((segment) => [
      segment.id,
      new Set(
        identity === LOCAL_TEST
          ? LOCAL_TEST_MEMBERS
          : csvList(get(`AW_M1_${segment.id.toUpperCase().replaceAll('-', '_')}_MEMBERS`)).map(
              (e) => e.toLowerCase(),
            ),
      ),
    ]),
  );
}

function missingConfig(
  config: Pick<WebConfig, 'identity' | 'segments' | 'members'>,
  clientId: string | undefined,
  clientSecret: string | undefined,
): readonly string[] {
  return [
    ...(config.identity === 'google' && clientId === undefined ? ['AW_M1_GOOGLE_CLIENT_ID'] : []),
    ...(config.identity === 'google' && clientSecret === undefined
      ? ['AW_M1_GOOGLE_CLIENT_SECRET']
      : []),
    ...config.segments
      .filter((s) => (config.members.get(s.id)?.size ?? 0) === 0)
      .map((s) => `AW_M1_${s.id.toUpperCase()}_MEMBERS`),
  ];
}

export function readWebConfig(env: Env): WebConfig {
  const file = readEnvFile(env.AW_SECRETS_FILE);
  const get: Lookup = (key) => {
    const value = file.get(key)?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  const identity: IdentityMode = env.AW_IDENTITY === LOCAL_TEST ? LOCAL_TEST : 'google';
  const segments = parseSegments(env.AW_SEGMENTS, csvList(env.AW_ALLOWED_BACKEND_HOSTS));
  const clientId = get('AW_M1_GOOGLE_CLIENT_ID');
  const clientSecret = get('AW_M1_GOOGLE_CLIENT_SECRET');
  const members = membersOf(segments, identity, get);
  const e2eSecret = env.AW_E2E_MODE === '1' ? get('AW_M1_E2E_SESSION_SECRET') : undefined;
  return {
    publicUrl: (env.AW_PUBLIC_URL ?? 'http://localhost:8280').replace(/\/$/, ''),
    identity,
    segments,
    databaseUrl: env.DATABASE_URL ?? '',
    keyDir: env.AW_KEY_DIR ?? '/data/keys',
    google:
      clientId === undefined || clientSecret === undefined ? undefined : { clientId, clientSecret },
    members,
    e2eSecret: e2eSecret !== undefined && e2eSecret.length >= 32 ? e2eSecret : undefined,
    missing: missingConfig({ identity, segments, members }, clientId, clientSecret),
  };
}

export function segmentsFor(config: WebConfig, email: string): readonly Segment[] {
  return config.segments.filter(
    (segment) => config.members.get(segment.id)?.has(email.toLowerCase()) === true,
  );
}
