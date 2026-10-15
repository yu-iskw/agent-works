import { defineConfig } from '@playwright/test';

import type { PlaywrightTestConfig } from '@playwright/test';

export type DevEnv = Readonly<Record<string, string | undefined>>;

export const DEV_SPEC_FILES = [
  'dev/identity-smoke.spec.ts',
  'dev/cross-user.spec.ts',
  'dev/direct-url.spec.ts',
] as const;

const REQUIRED_ENV_KEYS = [
  'AW_DEV_URL',
  'AW_DEV_OPERATOR_APPROVED_URL',
  'AW_DEV_ID_TOKEN_A',
  'AW_DEV_ID_TOKEN_B',
] as const;

export function isDevConfigAbsent(env: DevEnv = process.env): boolean {
  return REQUIRED_ENV_KEYS.every((key) => {
    // eslint-disable-next-line security/detect-object-injection -- key is from a fixed literal tuple
    const value = env[key];
    return value === undefined || value.trim().length === 0;
  });
}

function isForbiddenLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.test') ||
    host === '127.0.0.1' ||
    host.startsWith('127.') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    host.startsWith('[')
  ) {
    return true;
  }
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
}

export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim().length === 0) return new Set();
  const hosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) continue;
    if (isForbiddenLocalHost(candidate)) {
      throw new Error(
        `AW_DEV_ALLOWED_HOSTS must not contain localhost, loopback, or IP host "${candidate}"`,
      );
    }
    hosts.add(candidate);
  }
  return hosts;
}

function parseHttpsUrl(rawUrl: string | undefined, envName: string): URL {
  const trimmed = rawUrl?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new Error(`${envName} is required; refusing to fall back to local stack`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use https: (got ${parsed.protocol})`);
  }
  return parsed;
}

function assertCleanUrlParts(parsed: URL, envName: string): void {
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error(`${envName} must not embed credentials in the URL`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(`${envName} must not include query parameters or hash fragments`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${envName} must be an origin URL without a path`);
  }
}

export function validateDevServiceUrl(
  rawUrl: string | undefined,
  allowedHosts: ReadonlySet<string>,
  envName: string,
): string {
  const parsed = parseHttpsUrl(rawUrl, envName);
  assertCleanUrlParts(parsed, envName);
  const host = parsed.hostname.toLowerCase();
  if (isForbiddenLocalHost(host)) {
    throw new Error(`${envName} must not target localhost, loopback, or raw IP addresses`);
  }
  const isRunApp = host.endsWith('.run.app') && host.length > '.run.app'.length;
  if (!isRunApp && !allowedHosts.has(host)) {
    throw new Error(
      `${envName} host "${host}" must end with .run.app or be explicitly listed in AW_DEV_ALLOWED_HOSTS`,
    );
  }
  return parsed.origin;
}

export function resolveDevApiUrl(env: DevEnv = process.env): string | undefined {
  const allowedHosts = parseAllowedHosts(env.AW_DEV_ALLOWED_HOSTS);
  const baseURL = validateDevServiceUrl(env.AW_DEV_URL, allowedHosts, 'AW_DEV_URL');
  const configured = env.AW_DEV_API_URL?.trim();
  if (configured !== undefined && configured.length > 0) {
    return validateDevServiceUrl(configured, allowedHosts, 'AW_DEV_API_URL');
  }
  const parsed = parseHttpsUrl(baseURL, 'AW_DEV_URL');
  if (parsed.hostname.startsWith('aw-web-')) {
    parsed.hostname = parsed.hostname.replace(/^aw-web-/, 'aw-api-');
    return parsed.origin;
  }
  return undefined;
}

export type CrossUserResourceConfig =
  | {
      readonly status: 'ready';
      readonly resourcePath: string;
      readonly canary: string;
    }
  | {
      readonly status: 'blocked';
      readonly reason: string;
    };

export function resolveCrossUserResourceConfig(env: DevEnv = process.env): CrossUserResourceConfig {
  const resourcePath = env.AW_DEV_USER_A_RESOURCE_PATH?.trim() ?? '';
  const canary = env.AW_DEV_USER_A_PRIVATE_CANARY?.trim() ?? '';
  if (resourcePath.length === 0 || canary.length === 0) {
    return {
      status: 'blocked',
      reason:
        'BLOCKED: aw-web (apps/web/app/web-app.ts, apps/web/src/server.ts) exposes no GET route for ask/citation/audit records created by POST /, does not proxy /v1/* routes, and /approvals/:id cannot be created from aw-web (and maps upstream 403 to 503 in apps/web/app/approvals/reader.ts). Follow-up issue required to expose a user-scoped readable resource route on aw-web, or set AW_DEV_USER_A_RESOURCE_PATH and AW_DEV_USER_A_PRIVATE_CANARY once that route exists.',
    };
  }
  if (!resourcePath.startsWith('/') || resourcePath.startsWith('//')) {
    throw new Error('AW_DEV_USER_A_RESOURCE_PATH must be a relative path starting with "/"');
  }
  if (resourcePath === '/v1' || resourcePath.startsWith('/v1/')) {
    throw new Error(
      'AW_DEV_USER_A_RESOURCE_PATH must not target /v1/* on aw-web (aw-web returns 404 for all /v1/* routes)',
    );
  }
  return { status: 'ready', resourcePath, canary };
}

export function evaluateCrossUserProbe(input: {
  readonly resourcePath: string;
  readonly canary: string;
  readonly userAStatus: number;
  readonly userABody: string;
  readonly userBStatus: number;
  readonly userBBody: string;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 'BLOCKED' | 'FAILED'; readonly reason: string } {
  if (input.userAStatus !== 200) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `BLOCKED: Positive control failed on ${input.resourcePath}: User A received HTTP ${input.userAStatus} (expected 200)`,
    };
  }
  if (!input.userABody.includes(input.canary)) {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: `BLOCKED: Positive control failed on ${input.resourcePath}: User A response did not contain AW_DEV_USER_A_PRIVATE_CANARY`,
    };
  }
  const trimmedUserABody = input.userABody.trim();
  if (
    input.userBBody.includes(input.canary) ||
    (trimmedUserABody.length > 0 && input.userBBody.includes(trimmedUserABody))
  ) {
    return {
      ok: false,
      status: 'FAILED',
      reason: `HARD FAILURE: User B response on ${input.resourcePath} (HTTP ${input.userBStatus}) leaked User A private canary or content`,
    };
  }
  if (input.userBStatus !== 403 && input.userBStatus !== 404) {
    return {
      ok: false,
      status: 'FAILED',
      reason: `HARD FAILURE: User B received HTTP ${input.userBStatus} on ${input.resourcePath} (expected 403 or 404)`,
    };
  }
  return { ok: true };
}

function validateIdentityToken(rawToken: string | undefined, envName: string): string {
  const trimmed = rawToken?.trim() ?? '';
  if (trimmed.length === 0) {
    throw new Error(`${envName} is required for dev e2e authentication`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(`${envName} must be a single bearer token without whitespace`);
  }
  return trimmed;
}

function decodeJwtIdentityClaims(token: string): { sub?: string; email?: string } | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) return undefined;
  const payloadSegment = segments.at(1);
  if (payloadSegment === undefined || payloadSegment.length === 0) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return undefined;
    const record = decoded as Record<string, unknown>;
    return {
      sub: typeof record.sub === 'string' && record.sub.length > 0 ? record.sub : undefined,
      email:
        typeof record.email === 'string' && record.email.length > 0
          ? record.email.toLowerCase()
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function assertDistinctIdentities(tokenA: string, tokenB: string): void {
  if (tokenA === tokenB) {
    throw new Error(
      'AW_DEV_ID_TOKEN_A and AW_DEV_ID_TOKEN_B must be distinct tokens for two distinct test users',
    );
  }
  const claimsA = decodeJwtIdentityClaims(tokenA);
  const claimsB = decodeJwtIdentityClaims(tokenB);
  if (claimsA !== undefined && claimsB !== undefined) {
    if (claimsA.sub !== undefined && claimsA.sub === claimsB.sub) {
      throw new Error(
        'AW_DEV_ID_TOKEN_A and AW_DEV_ID_TOKEN_B must belong to distinct subjects (sub claim matches)',
      );
    }
    if (claimsA.email !== undefined && claimsA.email === claimsB.email) {
      throw new Error(
        'AW_DEV_ID_TOKEN_A and AW_DEV_ID_TOKEN_B must belong to distinct users (email claim matches)',
      );
    }
  }
}

export function loadDevConfig(env: DevEnv = process.env): PlaywrightTestConfig {
  const allowedHosts = parseAllowedHosts(env.AW_DEV_ALLOWED_HOSTS);
  const baseURL = validateDevServiceUrl(env.AW_DEV_URL, allowedHosts, 'AW_DEV_URL');
  const approvedRaw = env.AW_DEV_OPERATOR_APPROVED_URL?.trim() ?? '';
  if (approvedRaw.length === 0) {
    throw new Error('AW_DEV_OPERATOR_APPROVED_URL is required to confirm operator approval');
  }
  const approvedURL = validateDevServiceUrl(
    approvedRaw,
    allowedHosts,
    'AW_DEV_OPERATOR_APPROVED_URL',
  );
  if (approvedRaw !== (env.AW_DEV_URL?.trim() ?? '') || approvedURL !== baseURL) {
    throw new Error('AW_DEV_OPERATOR_APPROVED_URL must exactly match AW_DEV_URL');
  }
  resolveDevApiUrl(env);
  const tokenA = validateIdentityToken(env.AW_DEV_ID_TOKEN_A, 'AW_DEV_ID_TOKEN_A');
  const tokenB = validateIdentityToken(env.AW_DEV_ID_TOKEN_B, 'AW_DEV_ID_TOKEN_B');
  assertDistinctIdentities(tokenA, tokenB);

  return {
    testDir: '.',
    testMatch: [...DEV_SPEC_FILES],
    testIgnore: [
      'dev/workflow-cloud.spec.ts',
      'web/**',
      'security/**',
      'adversarial/**',
      'contract/**',
    ],
    outputDir: 'test-results',
    reporter: [['line'], ['./web/artifacts-reporter.mjs']],
    retries: 0,
    workers: 1,
    use: {
      baseURL,
      screenshot: 'on',
      trace: 'on',
      video: 'on',
    },
    projects: [
      {
        name: 'dev-identity-smoke',
        testMatch: 'dev/identity-smoke.spec.ts',
        use: {
          baseURL,
          extraHTTPHeaders: {
            Authorization: `Bearer ${tokenA}`,
          },
        },
      },
      {
        name: 'dev-cross-user',
        testMatch: 'dev/cross-user.spec.ts',
        use: {
          baseURL,
          extraHTTPHeaders: {
            Authorization: `Bearer ${tokenB}`,
          },
        },
      },
      {
        name: 'dev-direct-url',
        testMatch: 'dev/direct-url.spec.ts',
        use: {
          baseURL,
        },
      },
    ],
  };
}

export function requireDevPlaywrightConfig(env: DevEnv = process.env): PlaywrightTestConfig {
  if (env.PLAYWRIGHT_DEV_CONFIG !== '1') {
    throw new Error(
      'Dev cloud specs refuse to run unless loaded via e2e/playwright.dev.config.ts (PLAYWRIGHT_DEV_CONFIG=1)',
    );
  }
  return loadDevConfig(env);
}

function isKnipProcess(argv: readonly string[]): boolean {
  return argv.some((arg) => {
    const normalized = arg.replaceAll('\\', '/').toLowerCase();
    return (
      normalized === 'knip' ||
      normalized.endsWith('/knip') ||
      normalized.endsWith('/knip.js') ||
      normalized.endsWith('/knip.mjs') ||
      normalized.endsWith('/knip.cjs')
    );
  });
}

function isHelperImport(
  env: DevEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  if (env.AW_DEV_FORCE_LOAD === '1') return false;
  if (argv.some((arg) => arg.includes('playwright.dev.config'))) return false;
  if (env.VITEST === 'true') return true;
  if (isKnipProcess(argv)) return true;
  return argv.some((arg) => arg.includes('playwright.config'));
}

const helperImport = isHelperImport();
if (!helperImport) {
  process.env.PLAYWRIGHT_DEV_CONFIG = '1';
}

export default helperImport && isDevConfigAbsent(process.env)
  ? defineConfig({
      testDir: '.',
      testMatch: [...DEV_SPEC_FILES],
    })
  : defineConfig(loadDevConfig(process.env));
