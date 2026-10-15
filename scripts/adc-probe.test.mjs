import { describe, expect, it } from 'vitest';

import { createHandler, createProbe } from './adc-probe.mjs';

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

  it('rejects invalid service_account_impersonation_url without sending bearer token', async () => {
    for (const badUrl of [
      'http://evil.example/v1/projects/-/serviceAccounts/sa@demo.iam.gserviceaccount.com:generateAccessToken',
      'https://evil.example/v1/projects/-/serviceAccounts/sa@demo.iam.gserviceaccount.com:generateAccessToken',
      'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@demo.iam.gserviceaccount.com:other',
      123,
      null,
    ]) {
      const impersonated = {
        type: 'impersonated_service_account',
        service_account_impersonation_url: badUrl,
        source_credentials: user,
      };
      const { calls, probe } = harness(impersonated, [token, project]);
      const result = await probe.check();
      expect(result).toEqual({ ok: false, error: 'invalid impersonation url in ADC file' });
      expect(calls.every((call) => call.url.startsWith('https://oauth2.googleapis.com/'))).toBe(
        true,
      );
      expect(calls.some((call) => call.init?.headers?.authorization)).toBe(false);
    }
  });

  it('rejects authorized_user missing client_id, client_secret or refresh_token before fetch', async () => {
    for (const field of ['client_id', 'client_secret', 'refresh_token']) {
      for (const bad of ['', undefined, 123]) {
        const { calls, probe } = harness({ ...user, [field]: bad }, [token, project]);
        const result = await probe.check();
        expect(result).toEqual({
          ok: false,
          error: 'ADC file is missing client_id, client_secret or refresh_token',
        });
        expect(calls).toHaveLength(0);
      }
    }
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

  it('caches a successful result for 30 seconds and retries after failure', async () => {
    let ok = false;
    const calls = [];
    const clock = { time: 0 };
    const probe = createProbe({
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).startsWith(token.prefix)) {
          return ok ? token.reply : reply(400, { error: 'invalid_grant' });
        }
        return project.reply;
      },
      readFile: async () => JSON.stringify(user),
      env,
      now: () => clock.time,
    });

    expect((await probe.check()).ok).toBe(false);
    expect(calls).toHaveLength(1);

    ok = true;
    expect((await probe.check()).ok).toBe(true);
    const afterRecovery = calls.length;
    expect(afterRecovery).toBe(3);

    clock.time = 29_000;
    expect((await probe.check()).ok).toBe(true);
    expect(calls).toHaveLength(afterRecovery);

    clock.time = 31_000;
    expect((await probe.check()).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(afterRecovery);
  });
});

describe('createHandler', () => {
  function callHandler(result, url) {
    const handler = createHandler({ check: async () => result });
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
        return this;
      },
      end(chunk = '') {
        this.body = chunk;
      },
    };
    return handler({ url }, res).then(() => res);
  }

  it('serves /healthz 200 ok and 503 unhealthy', async () => {
    const healthy = await callHandler({ ok: true }, '/healthz');
    expect(healthy.status).toBe(200);
    expect(healthy.body).toBe('ok');

    const unhealthy = await callHandler({ ok: false, error: 'probe failed' }, '/healthz');
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body).toBe('unhealthy');
  });

  it('serves /gcp 200 and 503 with JSON body', async () => {
    const okPayload = { ok: true, projectId: 'demo-project' };
    const healthy = await callHandler(okPayload, '/gcp');
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body)).toEqual(okPayload);

    const errPayload = { ok: false, error: 'probe failed' };
    const unhealthy = await callHandler(errPayload, '/gcp');
    expect(unhealthy.status).toBe(503);
    expect(JSON.parse(unhealthy.body)).toEqual(errPayload);
  });

  it('returns 404 for unknown path', async () => {
    const res = await callHandler({ ok: true }, '/other');
    expect(res.status).toBe(404);
    expect(res.body).toBe('');
  });
});
