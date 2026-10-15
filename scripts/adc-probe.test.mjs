import { describe, expect, it } from 'vitest';

import { createProbe } from './adc-probe.mjs';

const SECRET = 'super-secret-refresh-token';
const env = {
  GOOGLE_APPLICATION_CREDENTIALS: '/gcloud/application_default_credentials.json',
  GOOGLE_CLOUD_PROJECT: 'demo-project',
};
const user = {
  type: 'authorized_user',
  client_id: 'client-id',
  client_secret: 'client-secret',
  refresh_token: SECRET,
  quota_project_id: 'demo-project',
};

function reply(status, body) {
  return { status, json: async () => body };
}

function harness(credentials, routes, overrides = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find((entry) => String(url).startsWith(entry.prefix));
    return route ? route.reply : reply(404, {});
  };
  const clock = { time: 0 };
  const probe = createProbe({
    fetch,
    readFile: async () => JSON.stringify(credentials),
    env: { ...env, ...overrides },
    now: () => clock.time,
  });
  return { calls, clock, probe };
}

const token = {
  prefix: 'https://oauth2.googleapis.com/token',
  reply: reply(200, { access_token: 'at-1' }),
};
const project = {
  prefix: 'https://cloudresourcemanager.googleapis.com/v3/projects/demo-project',
  reply: reply(200, { state: 'ACTIVE', name: 'projects/1' }),
};

describe('adc probe', () => {
  it('calls the project API with a token refreshed from authorized_user ADC', async () => {
    const { calls, probe } = harness(user, [token, project]);
    const result = await probe.check();
    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      credentialType: 'authorized_user',
      impersonated: false,
      lifecycleState: 'ACTIVE',
    });
    const read = calls.at(-1);
    expect(read.init.headers.authorization).toBe('Bearer at-1');
    expect(read.init.headers['x-goog-user-project']).toBe('demo-project');
  });

  it('follows impersonated_service_account credentials', async () => {
    const impersonated = {
      type: 'impersonated_service_account',
      service_account_impersonation_url:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@demo.iam.gserviceaccount.com:generateAccessToken',
      source_credentials: user,
    };
    const { calls, probe } = harness(impersonated, [
      token,
      {
        prefix: 'https://iamcredentials.googleapis.com/',
        reply: reply(200, { accessToken: 'at-sa' }),
      },
      project,
    ]);
    const result = await probe.check();
    expect(result).toMatchObject({ ok: true, impersonated: true });
    expect(calls.at(-1).init.headers.authorization).toBe('Bearer at-sa');
  });

  it('impersonates AW_IMPERSONATE_SERVICE_ACCOUNT on top of user ADC', async () => {
    const { calls, probe } = harness(
      user,
      [
        token,
        {
          prefix: 'https://iamcredentials.googleapis.com/',
          reply: reply(200, { accessToken: 'at-sa' }),
        },
        project,
      ],
      { AW_IMPERSONATE_SERVICE_ACCOUNT: 'sa@demo.iam.gserviceaccount.com' },
    );
    expect(await probe.check()).toMatchObject({ ok: true, impersonated: true });
    expect(calls.some((call) => call.url.includes('sa%40demo.iam.gserviceaccount.com'))).toBe(true);
  });

  it('rejects service account key files', async () => {
    const { calls, probe } = harness({ type: 'service_account', private_key: 'x' }, []);
    const result = await probe.check();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no key files');
    expect(calls).toHaveLength(0);
  });

  it('never leaks credentials or response bodies', async () => {
    const { probe } = harness(user, [
      token,
      {
        prefix: 'https://cloudresourcemanager.googleapis.com/',
        reply: reply(403, { error: { status: 'PERMISSION_DENIED', message: SECRET } }),
      },
    ]);
    const output = JSON.stringify(await probe.check());
    expect(output).toContain('PERMISSION_DENIED');
    for (const secret of [SECRET, 'client-secret', 'at-1']) expect(output).not.toContain(secret);
  });

  it('reports a failed refresh without the refresh token', async () => {
    const { probe } = harness(user, [
      {
        prefix: 'https://oauth2.googleapis.com/token',
        reply: reply(400, { error: 'invalid_grant' }),
      },
    ]);
    const result = await probe.check();
    expect(result).toEqual({ ok: false, error: 'token refresh failed: HTTP 400 invalid_grant' });
  });

  it('caches the result for 30 seconds', async () => {
    const { calls, clock, probe } = harness(user, [token, project]);
    await probe.check();
    const first = calls.length;
    clock.time = 29_000;
    await probe.check();
    expect(calls).toHaveLength(first);
    clock.time = 31_000;
    await probe.check();
    expect(calls.length).toBeGreaterThan(first);
  });
});
