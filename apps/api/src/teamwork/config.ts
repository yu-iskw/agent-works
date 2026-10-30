import { csvList, readEnvFile } from '@agent-works/domain/env-file';
import {
  ASSERTION_ISSUERS,
  CAPABILITIES,
  capabilitySchema,
  segmentIdSchema,
} from '@agent-works/domain/teamwork';

import type { Capability, IdentityMode, SegmentId } from '@agent-works/domain/teamwork';

type Env = Readonly<Record<string, string | undefined>>;

type OAuthClient = { readonly clientId: string; readonly clientSecret: string };

export type SegmentSources = {
  readonly driveResearchFolder: string | undefined;
  readonly driveContextFolder: string | undefined;
  readonly bigqueryProject: string | undefined;
  readonly bigqueryDataset: string | undefined;
  readonly githubRepositories: readonly string[];
  readonly githubPinnedRef: string | undefined;
  readonly githubIssue: number | undefined;
};

type SourceMode = 'live' | 'fixture';

export type SegmentConfig = {
  readonly segment: SegmentId;
  readonly segmentName: string;
  readonly databaseUrl: string;
  readonly publicUrl: string;
  readonly identity: IdentityMode;
  readonly assertion: {
    readonly jwksUrl: string;
    readonly issuer: string;
    readonly audience: string;
  };
  readonly members: ReadonlySet<string>;
  /** Members whose entitlement excludes external effects (no `docs.publish`). */
  readonly readOnlyMembers: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<Capability>;
  readonly sourceMode: SourceMode;
  readonly sources: SegmentSources;
  readonly google: OAuthClient | undefined;
  readonly github: OAuthClient | undefined;
  readonly keyDir: string;
  readonly maxModelCalls: number;
  readonly concurrency: number;
  readonly assignmentDeadlineMs: number;
  /** Names of required settings that are missing; readiness lists them, never their values. */
  readonly missing: readonly string[];
};

/** Unset means the default; anything that is not a whole number fails closed to zero. */
function wholeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
}

type Secret = (key: string) => string | undefined;

/** Fixture mode reads the local checkout as this repository and issue, unless configured otherwise. */
const FIXTURE_GITHUB = { repositories: ['yu-iskw/agent-works'], issue: '1' } as const;

function readSources(secret: Secret, upper: string, sourceMode: SourceMode): SegmentSources {
  const fixture = sourceMode === 'fixture' ? FIXTURE_GITHUB : undefined;
  const issue = secret(`AW_M1_${upper}_GITHUB_ISSUE`) ?? fixture?.issue;
  const repositories = csvList(secret('AW_M1_GITHUB_REPOSITORY'));
  return {
    driveResearchFolder: secret(`AW_M1_${upper}_DRIVE_RESEARCH_FOLDER`),
    driveContextFolder: secret(`AW_M1_${upper}_DRIVE_CONTEXT_FOLDER`),
    bigqueryProject: secret('AW_M1_BIGQUERY_PROJECT'),
    bigqueryDataset: secret(`AW_M1_${upper}_BIGQUERY_DATASET`),
    githubRepositories:
      repositories.length === 0 ? [...(fixture?.repositories ?? [])] : repositories,
    githubPinnedRef: secret('AW_M1_GITHUB_PINNED_REF'),
    githubIssue: issue === undefined || !/^\d+$/.test(issue) ? undefined : Number(issue),
  };
}

type MissingInput = {
  readonly upper: string;
  readonly identity: IdentityMode;
  readonly sourceMode: SourceMode;
  readonly members: ReadonlySet<string>;
  readonly google: OAuthClient | undefined;
  readonly github: OAuthClient | undefined;
  readonly sources: SegmentSources;
};

/** Each row names the settings reported missing when its predicate holds. */
function missingSettings({
  upper,
  identity,
  sourceMode,
  members,
  google,
  github,
  sources,
}: MissingInput): readonly string[] {
  const live = sourceMode === 'live';
  const rows: readonly (readonly [boolean, readonly string[]])[] = [
    [members.size === 0, [`AW_M1_${upper}_MEMBERS`]],
    [
      identity === 'google' && google === undefined,
      ['AW_M1_GOOGLE_CLIENT_ID', 'AW_M1_GOOGLE_CLIENT_SECRET'],
    ],
    [
      identity === 'google' && github === undefined,
      ['AW_M1_GITHUB_CLIENT_ID', 'AW_M1_GITHUB_CLIENT_SECRET'],
    ],
    [live && !sources.driveResearchFolder, [`AW_M1_${upper}_DRIVE_RESEARCH_FOLDER`]],
    [live && !sources.driveContextFolder, [`AW_M1_${upper}_DRIVE_CONTEXT_FOLDER`]],
    [live && !sources.bigqueryProject, ['AW_M1_BIGQUERY_PROJECT']],
    [live && !sources.bigqueryDataset, [`AW_M1_${upper}_BIGQUERY_DATASET`]],
    [live && sources.githubRepositories.length === 0, ['AW_M1_GITHUB_REPOSITORY']],
    [live && sources.githubIssue === undefined, [`AW_M1_${upper}_GITHUB_ISSUE`]],
  ];
  return rows.flatMap(([missing, names]) => (missing ? names : []));
}

export function readSegmentConfig(env: Env): SegmentConfig {
  const segment = segmentIdSchema.parse(env.AW_SEGMENT_ID);
  const secrets = readEnvFile(env.AW_SECRETS_FILE);
  const upper = segment.toUpperCase().replaceAll('-', '_');
  const secret: Secret = (key) => {
    const value = secrets.get(key)?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  const identity: IdentityMode = env.AW_IDENTITY === 'local-test' ? 'local-test' : 'google';
  const sourceMode: SourceMode = env.AW_SOURCE_MODE === 'fixture' ? 'fixture' : 'live';
  const membersRaw =
    identity === 'google' ? secret(`AW_M1_${upper}_MEMBERS`) : env.AW_LOCAL_TEST_MEMBERS;
  const members = new Set(csvList(membersRaw).map((email) => email.toLowerCase()));
  const pair = (id: string, key: string): OAuthClient | undefined => {
    const clientId = secret(id);
    const clientSecret = secret(key);
    return clientId === undefined || clientSecret === undefined
      ? undefined
      : { clientId, clientSecret };
  };
  const google = pair('AW_M1_GOOGLE_CLIENT_ID', 'AW_M1_GOOGLE_CLIENT_SECRET');
  const github = pair('AW_M1_GITHUB_CLIENT_ID', 'AW_M1_GITHUB_CLIENT_SECRET');
  const sources = readSources(secret, upper, sourceMode);
  const capabilities = new Set(
    csvList(env.AW_SEGMENT_CAPABILITIES ?? CAPABILITIES.join(',')).map((item) =>
      capabilitySchema.parse(item),
    ),
  );
  return {
    segment,
    segmentName: env.AW_SEGMENT_NAME?.trim() || segment,
    databaseUrl: env.DATABASE_URL ?? '',
    publicUrl: (env.AW_PUBLIC_URL ?? 'http://localhost:8280').replace(/\/$/, ''),
    identity,
    assertion: {
      jwksUrl: env.AW_ASSERTION_JWKS_URL ?? 'http://web:8081/internal/jwks',
      // eslint-disable-next-line security/detect-object-injection
      issuer: ASSERTION_ISSUERS[identity],
      audience: `segment:${segment}`,
    },
    members,
    readOnlyMembers: new Set(
      csvList(secret(`AW_M1_${upper}_READONLY_MEMBERS`)).map((email) => email.toLowerCase()),
    ),
    capabilities,
    sourceMode,
    sources,
    google,
    github,
    keyDir: env.AW_KEY_DIR ?? '/data/keys',
    maxModelCalls: wholeNumber(env.AW_MAX_MODEL_CALLS, 200),
    concurrency: Math.max(1, Math.min(4, wholeNumber(env.AW_WORKER_CONCURRENCY, 2))),
    assignmentDeadlineMs: wholeNumber(env.AW_ASSIGNMENT_DEADLINE_MS, 5 * 60_000),
    missing: missingSettings({ upper, identity, sourceMode, members, google, github, sources }),
  };
}
