import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IMPERSONATE_URL = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';
const CACHE_MS = 30_000;

class ProbeError extends Error {}

/**
 * Local-development probe: proves a container can call a Google Cloud API with the
 * mounted Application Default Credentials (ADC), keylessly and read-only.
 * Output never contains tokens, credential contents or response bodies.
 */
export function createProbe({ fetch, readFile: read, env, now = Date.now }) {
  let cached;

  async function postJson(url, body, headers = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await safeJson(response) };
  }

  async function refreshToken(credentials) {
    if (
      typeof credentials.client_id !== 'string' ||
      !credentials.client_id ||
      typeof credentials.client_secret !== 'string' ||
      !credentials.client_secret ||
      typeof credentials.refresh_token !== 'string' ||
      !credentials.refresh_token
    ) {
      throw new ProbeError('ADC file is missing client_id, client_secret or refresh_token');
    }
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      }),
    });
    const json = await safeJson(response);
    if (response.status !== 200 || typeof json?.access_token !== 'string') {
      throw new ProbeError(`token refresh failed: ${describe(response.status, json)}`);
    }
    return json.access_token;
  }

  async function impersonate(url, accessToken) {
    const { status, json } = await postJson(
      url,
      { scope: [SCOPE] },
      { authorization: `Bearer ${accessToken}` },
    );
    if (status !== 200 || typeof json?.accessToken !== 'string') {
      throw new ProbeError(`impersonation failed: ${describe(status, json)}`);
    }
    return json.accessToken;
  }

  async function accessTokenFor(credentials) {
    if (credentials.type === 'authorized_user') return refreshToken(credentials);
    if (credentials.type === 'impersonated_service_account') {
      const url = credentials.service_account_impersonation_url;
      if (
        typeof url !== 'string' ||
        !url.startsWith(`${IMPERSONATE_URL}/`) ||
        !url.endsWith(':generateAccessToken')
      ) {
        throw new ProbeError('invalid impersonation url in ADC file');
      }
      const source = await accessTokenFor(credentials.source_credentials ?? {});
      return impersonate(url, source);
    }
    throw new ProbeError(
      'unsupported credential type: use `gcloud auth application-default login` (no key files)',
    );
  }

  async function run() {
    const path = env.GOOGLE_APPLICATION_CREDENTIALS;
    const projectId = env.GOOGLE_CLOUD_PROJECT;
    if (!path || !projectId) {
      throw new ProbeError('GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT are required');
    }
    const credentials = JSON.parse(await read(path, 'utf8'));
    let token = await accessTokenFor(credentials);
    const target = env.AW_IMPERSONATE_SERVICE_ACCOUNT;
    if (target) {
      token = await impersonate(
        `${IMPERSONATE_URL}/${encodeURIComponent(target)}:generateAccessToken`,
        token,
      );
    }
    const api = `https://cloudresourcemanager.googleapis.com/v3/projects/${encodeURIComponent(projectId)}`;
    const headers = { authorization: `Bearer ${token}` };
    if (credentials.quota_project_id) headers['x-goog-user-project'] = credentials.quota_project_id;
    const response = await fetch(api, { headers });
    const json = await safeJson(response);
    return {
      ok: response.status === 200,
      api: 'cloudresourcemanager.googleapis.com projects.get',
      httpStatus: response.status,
      credentialType: credentials.type,
      impersonated: credentials.type === 'impersonated_service_account' || Boolean(target),
      projectId,
      lifecycleState: typeof json?.state === 'string' ? json.state : undefined,
      ...(response.status === 200 ? {} : { error: describe(response.status, json) }),
    };
  }

  async function check() {
    if (cached && now() - cached.at < CACHE_MS) return cached.result;
    let result;
    try {
      result = await run();
    } catch (error) {
      result = { ok: false, error: error instanceof ProbeError ? error.message : 'probe failed' };
    }
    if (result.ok) cached = { at: now(), result };
    return result;
  }

  return { check };
}

export function createHandler(probe) {
  return async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://probe').pathname;
    if (path === '/healthz') {
      const { ok } = await probe.check();
      response.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' });
      response.end(ok ? 'ok' : 'unhealthy');
    } else if (path === '/gcp') {
      const result = await probe.check();
      response.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    } else {
      response.writeHead(404).end();
    }
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function describe(status, json) {
  const code = typeof json?.error?.status === 'string' ? json.error.status : json?.error;
  return typeof code === 'string' && /^[A-Za-z_ ]{1,40}$/.test(code)
    ? `HTTP ${status} ${code}`
    : `HTTP ${status}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const probe = createProbe({ fetch, readFile, env: process.env });
  const port = Number(process.env.PORT ?? 8090);
  createServer(createHandler(probe)).listen(port, '0.0.0.0', () => {
    process.stdout.write(`adc-probe listening on ${port}\n`);
  });
}
