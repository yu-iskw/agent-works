import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';

import { buildProviderPorts } from './ports.js';
import { assertStartup, classifyProviders, ProductionStartupRejected } from './providers.js';

const realEnv = {
  AW_MODE: 'production',
  DATABASE_URL: 'postgres://app:pw-secret@db.internal.example.com:5432/app',
  DRIVE_URL: 'https://drive.example.com',
  DIRECTORY_URL: 'https://directory.example.com',
  LLM_URL: 'https://llm.example.com',
  IAP_JWKS_URL: 'https://www.gstatic.com/iap/verify/public_key-jwk',
  IAP_ISSUER: 'https://cloud.google.com/iap',
  IAP_AUDIENCE: '/projects/1/global/backendServices/2',
  OAUTH_URL: 'https://oauth.example.com',
  OAUTH_REDIRECT_URI: 'https://app.example.com/oauth/callback',
  GOOGLE_OAUTH_CLIENT_ID: '123-client.apps.googleusercontent.com',
  OAUTH_HOSTED_DOMAIN: 'dr-ubie.com',
} as const;

const localEnv = {
  DATABASE_URL: 'postgres://app:app@localhost:5432/app',
  DRIVE_URL: 'http://localhost:8082',
  DIRECTORY_URL: 'http://localhost:8086',
  LLM_URL: 'http://localhost:8083',
  IAP_JWKS_URL: 'http://localhost:8081/jwks',
  IAP_ISSUER: 'fake',
  IAP_AUDIENCE: 'fake',
};

function without(key: keyof typeof realEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(realEnv).filter(([name]) => name !== key));
}

function rejected(env: Record<string, string | undefined>): ProductionStartupRejected {
  try {
    assertStartup(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ProductionStartupRejected);
    return error as ProductionStartupRejected;
  }
  throw new Error('expected rejection');
}

describe('production startup', () => {
  it('accepts a fully real configuration', () => {
    expect(() => assertStartup(realEnv)).not.toThrow();
    const reports = classifyProviders(realEnv);
    expect(reports.find((report) => report.name === 'incident-ticketing')?.status).toBe(
      'disabled-optional',
    );
  });

  it.each([
    ['identity', { IAP_JWKS_URL: 'http://fake-iap:8081/jwks' }, 'local-fake'],
    ['identity', { IAP_JWKS_URL: undefined }, 'missing'],
    ['model', { LLM_URL: 'http://fake-llm:8083' }, 'local-fake'],
    ['model', { LLM_URL: undefined }, 'missing'],
    ['source-storage', { DRIVE_URL: 'http://localhost:8082' }, 'local-fake'],
    ['source-storage', { DIRECTORY_URL: undefined }, 'missing'],
    ['authority-persistence', { DATABASE_URL: 'memory://tasks' }, 'local-fake'],
    ['authority-persistence', { DATABASE_URL: 'postgres://u:p@127.0.0.1/db' }, 'local-fake'],
    ['authority-persistence', { DATABASE_URL: undefined }, 'missing'],
    ['oauth-credentials', { OAUTH_URL: undefined }, 'missing'],
    ['oauth-credentials', { OAUTH_REDIRECT_URI: undefined }, 'missing'],
    ['oauth-credentials', { GOOGLE_OAUTH_CLIENT_ID: undefined }, 'missing'],
    ['oauth-credentials', { OAUTH_HOSTED_DOMAIN: '  ' }, 'missing'],
    ['oauth-credentials', { OAUTH_URL: 'http://fake-oauth:8087' }, 'local-fake'],
    [
      'oauth-credentials',
      { OAUTH_REDIRECT_URI: 'http://app.example.com/oauth/callback' },
      'local-fake',
    ],
    ['oauth-credentials', { OAUTH_REDIRECT_URI: 'http://fake-web/oauth/callback' }, 'local-fake'],
    [
      'oauth-credentials',
      {
        OAUTH_URL: 'http://localhost:8087',
        OAUTH_REDIRECT_URI: 'http://localhost:8080/oauth/callback',
      },
      'local-fake',
    ],
    ['required-config', { IAP_AUDIENCE: undefined }, 'missing'],
    ['required-config', { PORT: '99999' }, 'missing'],
    [
      'incident-ticketing',
      { INCIDENTS_URL: 'http://fake-incidents', TICKETS_URL: 'https://t.example.com' },
      'local-fake',
    ],
  ] as const)('rejects %s individually (%j)', (name, patch, status) => {
    const error = rejected({ ...realEnv, ...patch });
    const hit = error.reports.find((report) => report.name === name);
    expect(hit?.status).toBe(status);
    expect(
      error.reports.every((report) => report.name === name || report.name === 'required-config'),
    ).toBe(true);
  });

  it.each(['http://localhost:8080/oauth/callback', 'http://127.0.0.1:8080/oauth/callback'])(
    'admits the loopback proxy callback %s as the redirect only',
    (redirect) => {
      expect(() => assertStartup({ ...realEnv, OAUTH_REDIRECT_URI: redirect })).not.toThrow();
      expect(
        classifyProviders({ ...realEnv, OAUTH_REDIRECT_URI: redirect }).find(
          (r) => r.name === 'oauth-credentials',
        )?.status,
      ).toBe('real');
    },
  );

  it('rejects real incident ticketing while its receipts are process-local', () => {
    const error = rejected({
      ...realEnv,
      INCIDENTS_URL: 'https://incidents.example.com',
      TICKETS_URL: 'https://tickets.example.com',
    });
    expect(error.reports.map((report) => report.name)).toEqual(['incident-ticketing']);
    expect(error.message).toContain('process-local');
  });

  it('names providers and env variables without echoing any value', () => {
    const error = rejected({
      ...without('IAP_AUDIENCE'),
      DATABASE_URL: 'postgres://u:pw-secret@localhost/db',
    });
    expect(error.message).toContain('authority-persistence');
    expect(error.message).toContain('IAP_AUDIENCE');
    expect(error.message).not.toContain('pw-secret');
  });

  it('rejects the dev stack flag in production for every provider', () => {
    const error = rejected({ ...realEnv, AW_DEV_STACK: '1' });
    expect(error.reports.every((report) => report.status === 'local-fake')).toBe(true);
  });

  it('rejects an unknown mode instead of defaulting to local', () => {
    expect(() => assertStartup({ ...realEnv, AW_MODE: 'prod' })).toThrow('AW_MODE');
  });

  it('keeps local mode working with fakes', () => {
    expect(() => assertStartup(localEnv)).not.toThrow();
    expect(() => assertStartup({ ...localEnv, AW_MODE: 'local', AW_DEV_STACK: '1' })).not.toThrow();
    expect(classifyProviders(localEnv).find((report) => report.name === 'identity')?.status).toBe(
      'local-fake',
    );
  });
});

describe('provider ports', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds real ports from valid config without any network call', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const ports = buildProviderPorts(loadConfig(realEnv), realEnv, () => new Date());
    expect(ports.oauthProvider).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a directory outage as an error, never a fabricated result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    const ports = buildProviderPorts(loadConfig(realEnv), realEnv, () => new Date());
    await expect(ports.groups('alice')).rejects.toThrow();
  });
});
