import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import devPlaywrightDefaultConfig, {
  DEV_SPEC_FILES,
  evaluateCrossUserProbe,
  isDevConfigAbsent,
  loadDevConfig,
  parseAllowedHosts,
  requireDevPlaywrightConfig,
  resolveCrossUserResourceConfig,
  resolveDevApiUrl,
  validateDevServiceUrl,
} from './playwright.dev.config.js';

const validEnv = {
  AW_DEV_URL: 'https://aw-web-1234567890.asia-northeast1.run.app',
  AW_DEV_OPERATOR_APPROVED_URL: 'https://aw-web-1234567890.asia-northeast1.run.app',
  AW_DEV_ID_TOKEN_A: 'iap-id-token-user-alice- distinct-a',
  AW_DEV_ID_TOKEN_B: 'iap-id-token-user-bob-distinct-b',
} as const;

function makeCleanEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AW_DEV_URL: 'https://aw-web-1234567890.asia-northeast1.run.app',
    AW_DEV_OPERATOR_APPROVED_URL: 'https://aw-web-1234567890.asia-northeast1.run.app',
    AW_DEV_ID_TOKEN_A: 'token-user-a-0001',
    AW_DEV_ID_TOKEN_B: 'token-user-b-0002',
    ...overrides,
  };
}

describe('loadDevConfig', () => {
  it('fails closed when AW_DEV_URL is missing or blank', () => {
    expect(() => loadDevConfig(makeCleanEnv({ AW_DEV_URL: undefined }))).toThrow(/AW_DEV_URL/);
    expect(() => loadDevConfig(makeCleanEnv({ AW_DEV_URL: '   ' }))).toThrow(/AW_DEV_URL/);
  });

  it('rejects http URLs and never falls back to http://127.0.0.1:8085', () => {
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_URL: 'http://aw-web-1234567890.asia-northeast1.run.app',
          AW_DEV_OPERATOR_APPROVED_URL: 'http://aw-web-1234567890.asia-northeast1.run.app',
        }),
      ),
    ).toThrow(/https/i);
    expect(() => loadDevConfig({})).toThrow(/AW_DEV_URL/);
  });

  it('rejects localhost and 127.0.0.1 even if listed in AW_DEV_ALLOWED_HOSTS', () => {
    for (const forbidden of [
      'https://localhost:8085',
      'https://127.0.0.1:8085',
      'https://[::1]:8085',
      'https://0.0.0.0:8085',
    ]) {
      expect(() =>
        loadDevConfig(
          makeCleanEnv({
            AW_DEV_URL: forbidden,
            AW_DEV_OPERATOR_APPROVED_URL: forbidden,
            AW_DEV_ALLOWED_HOSTS: 'localhost,127.0.0.1,::1,0.0.0.0',
          }),
        ),
      ).toThrow(/localhost|loopback|local|host/i);
    }
  });

  it('rejects credentials embedded in AW_DEV_URL', () => {
    const withCreds = 'https://user:secret@aw-web-1234567890.asia-northeast1.run.app';
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_URL: withCreds,
          AW_DEV_OPERATOR_APPROVED_URL: withCreds,
        }),
      ),
    ).toThrow(/credential/i);
  });

  it('rejects non-run.app hosts unless explicitly listed in AW_DEV_ALLOWED_HOSTS', () => {
    const customHost = 'https://dev.agent-works.example.com';
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_URL: customHost,
          AW_DEV_OPERATOR_APPROVED_URL: customHost,
        }),
      ),
    ).toThrow(/run\.app|AW_DEV_ALLOWED_HOSTS/);

    const allowed = loadDevConfig(
      makeCleanEnv({
        AW_DEV_URL: customHost,
        AW_DEV_OPERATOR_APPROVED_URL: customHost,
        AW_DEV_ALLOWED_HOSTS: 'dev.agent-works.example.com, staging.agent-works.example.com',
      }),
    );
    expect(allowed.use?.baseURL).toBe(customHost);
  });

  it('validates AW_DEV_API_URL against parseAllowedHosts and derives aw-api Run URL when unset', () => {
    expect([
      ...parseAllowedHosts('api.agent-works.example.com, web.agent-works.example.com'),
    ]).toEqual(['api.agent-works.example.com', 'web.agent-works.example.com']);
    expect(resolveDevApiUrl(makeCleanEnv())).toBe(
      'https://aw-api-1234567890.asia-northeast1.run.app',
    );
    expect(
      resolveDevApiUrl(
        makeCleanEnv({
          AW_DEV_URL: 'https://web.agent-works.example.com',
          AW_DEV_OPERATOR_APPROVED_URL: 'https://web.agent-works.example.com',
          AW_DEV_API_URL: 'https://api.agent-works.example.com',
          AW_DEV_ALLOWED_HOSTS: 'web.agent-works.example.com,api.agent-works.example.com',
        }),
      ),
    ).toBe('https://api.agent-works.example.com');
    expect(() =>
      resolveDevApiUrl(
        makeCleanEnv({
          AW_DEV_API_URL: 'https://unapproved.agent-works.example.com',
        }),
      ),
    ).toThrow(/AW_DEV_ALLOWED_HOSTS/);
  });

  it('rejects when AW_DEV_OPERATOR_APPROVED_URL is missing or does not match AW_DEV_URL', () => {
    expect(() => loadDevConfig(makeCleanEnv({ AW_DEV_OPERATOR_APPROVED_URL: undefined }))).toThrow(
      /AW_DEV_OPERATOR_APPROVED_URL/,
    );
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_OPERATOR_APPROVED_URL: 'https://aw-web-other.asia-northeast1.run.app',
        }),
      ),
    ).toThrow(/AW_DEV_OPERATOR_APPROVED_URL/);
  });

  it('rejects missing, whitespace-containing, or identical identity tokens', () => {
    expect(() => loadDevConfig(makeCleanEnv({ AW_DEV_ID_TOKEN_A: undefined }))).toThrow(
      /AW_DEV_ID_TOKEN_A/,
    );
    expect(() => loadDevConfig(makeCleanEnv({ AW_DEV_ID_TOKEN_B: '' }))).toThrow(
      /AW_DEV_ID_TOKEN_B/,
    );
    expect(() => loadDevConfig(makeCleanEnv(validEnv))).toThrow(/AW_DEV_ID_TOKEN_A/);
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_ID_TOKEN_A: 'same-token-value',
          AW_DEV_ID_TOKEN_B: 'same-token-value',
        }),
      ),
    ).toThrow(/distinct/i);
  });

  it('rejects two JWT tokens that resolve to the same subject or email claim', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload1 = Buffer.from(
      JSON.stringify({ sub: '111111', email: 'yu.ishikawa@dr-ubie.com', exp: 1900000000 }),
    ).toString('base64url');
    const payload2 = Buffer.from(
      JSON.stringify({ sub: '111111', email: 'yu.ishikawa@dr-ubie.com', exp: 1900000060 }),
    ).toString('base64url');
    const token1 = `${header}.${payload1}.sig1`;
    const token2 = `${header}.${payload2}.sig2`;
    expect(() =>
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_ID_TOKEN_A: token1,
          AW_DEV_ID_TOKEN_B: token2,
        }),
      ),
    ).toThrow(/distinct/i);
  });

  it('never leaks token values in thrown error messages', () => {
    const secretToken = 'super-secret-iap-token-canary-999';
    try {
      loadDevConfig(
        makeCleanEnv({
          AW_DEV_ID_TOKEN_A: secretToken,
          AW_DEV_ID_TOKEN_B: secretToken,
        }),
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain(secretToken);
    }
  });

  it('excludes live dev specs from offline e2e/playwright.config.ts and requires PLAYWRIGHT_DEV_CONFIG=1', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reading committed config in same directory
    const offlineConfigSource = readFileSync(
      resolve(import.meta.dirname, 'playwright.config.ts'),
      'utf8',
    );
    expect(offlineConfigSource).toContain('dev/identity-smoke.spec.ts');
    expect(offlineConfigSource).toContain('dev/cross-user.spec.ts');
    expect(offlineConfigSource).toContain('dev/direct-url.spec.ts');

    expect(() => requireDevPlaywrightConfig(makeCleanEnv())).toThrow(/PLAYWRIGHT_DEV_CONFIG/);
    const loaded = requireDevPlaywrightConfig(
      makeCleanEnv({
        PLAYWRIGHT_DEV_CONFIG: '1',
      }),
    );
    expect(loaded.use?.baseURL).toBe('https://aw-web-1234567890.asia-northeast1.run.app');
  });

  it('enforces cross-user positive control and fails closed as BLOCKED when aw-web lacks a readable resource route', () => {
    const blocked = resolveCrossUserResourceConfig(makeCleanEnv());
    expect(blocked.status).toBe('blocked');
    if (blocked.status === 'blocked') {
      expect(blocked.reason).toContain('BLOCKED:');
      expect(blocked.reason).toContain('aw-web');
    }

    expect(() =>
      resolveCrossUserResourceConfig(
        makeCleanEnv({
          AW_DEV_USER_A_RESOURCE_PATH: '/v1/tasks/123',
          AW_DEV_USER_A_PRIVATE_CANARY: 'canary-alice-secret',
        }),
      ),
    ).toThrow(/\/v1\//);

    const ready = resolveCrossUserResourceConfig(
      makeCleanEnv({
        AW_DEV_USER_A_RESOURCE_PATH: '/approvals/apr-alice-1',
        AW_DEV_USER_A_PRIVATE_CANARY: 'canary-alice-secret',
      }),
    );
    expect(ready).toEqual({
      status: 'ready',
      resourcePath: '/approvals/apr-alice-1',
      canary: 'canary-alice-secret',
    });

    expect(
      evaluateCrossUserProbe({
        resourcePath: '/approvals/apr-alice-1',
        canary: 'canary-alice-secret',
        userAStatus: 404,
        userABody: 'not found',
        userBStatus: 404,
        userBBody: 'not found',
      }),
    ).toMatchObject({
      ok: false,
      status: 'BLOCKED',
    });

    expect(
      evaluateCrossUserProbe({
        resourcePath: '/approvals/apr-alice-1',
        canary: 'canary-alice-secret',
        userAStatus: 200,
        userABody: '<main>no canary here</main>',
        userBStatus: 404,
        userBBody: 'not found',
      }),
    ).toMatchObject({
      ok: false,
      status: 'BLOCKED',
    });

    expect(
      evaluateCrossUserProbe({
        resourcePath: '/approvals/apr-alice-1',
        canary: 'canary-alice-secret',
        userAStatus: 200,
        userABody: '<main>canary-alice-secret</main>',
        userBStatus: 404,
        userBBody: 'Approval not found. canary-alice-secret',
      }),
    ).toMatchObject({
      ok: false,
      status: 'FAILED',
    });

    expect(
      evaluateCrossUserProbe({
        resourcePath: '/approvals/apr-alice-1',
        canary: 'canary-alice-secret',
        userAStatus: 200,
        userABody: '<main>canary-alice-secret</main>',
        userBStatus: 503,
        userBBody: 'The approval service is unavailable.',
      }),
    ).toMatchObject({
      ok: false,
      status: 'FAILED',
    });

    expect(
      evaluateCrossUserProbe({
        resourcePath: '/approvals/apr-alice-1',
        canary: 'canary-alice-secret',
        userAStatus: 200,
        userABody: '<main>canary-alice-secret</main>',
        userBStatus: 404,
        userBBody: 'Approval not found.',
      }),
    ).toEqual({ ok: true });
  });

  it('returns the dev Playwright config on the happy path with no 127.0.0.1 fallback and no tokens in baseURL or project names', () => {
    const tokenA = 'secret-token-alice-value';
    const tokenB = 'secret-token-bob-value';
    const config = loadDevConfig(
      makeCleanEnv({
        AW_DEV_ID_TOKEN_A: tokenA,
        AW_DEV_ID_TOKEN_B: tokenB,
      }),
    );

    expect(config.use?.baseURL).toBe('https://aw-web-1234567890.asia-northeast1.run.app');
    expect(config.use?.baseURL).not.toContain('127.0.0.1');
    expect(config.use?.baseURL).not.toContain('localhost');
    expect(config.use?.baseURL).not.toContain(tokenA);
    expect(config.use?.baseURL).not.toContain(tokenB);
    expect(config.retries).toBe(0);
    expect(config.workers).toBe(1);

    const projects = config.projects ?? [];
    expect(projects.length).toBeGreaterThanOrEqual(3);

    const projectNames = projects.map((project) => project.name ?? '');
    for (const name of projectNames) {
      expect(name).not.toContain(tokenA);
      expect(name).not.toContain(tokenB);
    }

    const matchedSpecs = projects.flatMap((project) =>
      Array.isArray(project.testMatch) ? project.testMatch : [project.testMatch],
    );
    expect(matchedSpecs).toContain('dev/identity-smoke.spec.ts');
    expect(matchedSpecs).toContain('dev/cross-user.spec.ts');
    expect(matchedSpecs).toContain('dev/direct-url.spec.ts');
    expect(matchedSpecs).not.toContain('dev/workflow-cloud.spec.ts');

    const userAProject = projects.find((project) => project.name === 'dev-identity-smoke');
    const userBProject = projects.find((project) => project.name === 'dev-cross-user');
    const directUrlProject = projects.find((project) => project.name === 'dev-direct-url');

    expect(userAProject?.use?.extraHTTPHeaders).toEqual({
      Authorization: `Bearer ${tokenA}`,
    });
    expect(userBProject?.use?.extraHTTPHeaders).toEqual({
      Authorization: `Bearer ${tokenB}`,
    });
    expect(directUrlProject?.use?.extraHTTPHeaders).toBeUndefined();
    expect(DEV_SPEC_FILES).toEqual([
      'dev/identity-smoke.spec.ts',
      'dev/cross-user.spec.ts',
      'dev/direct-url.spec.ts',
    ]);
    expect(isDevConfigAbsent({})).toBe(true);
    expect(isDevConfigAbsent(makeCleanEnv())).toBe(false);
    expect(devPlaywrightDefaultConfig).toBeDefined();
    expect(
      validateDevServiceUrl(
        'https://aw-api-1234567890.asia-northeast1.run.app',
        new Set(),
        'AW_DEV_API_URL',
      ),
    ).toBe('https://aw-api-1234567890.asia-northeast1.run.app');
  });
});
