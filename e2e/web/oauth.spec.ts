import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { expect, test } from '@playwright/test';

import type { ChildProcess } from 'node:child_process';

test.use({ extraHTTPHeaders: { 'x-goog-iap-jwt-assertion': 'alice' } });

let webUrl: string;
let fixture: ChildProcess;

const script = `
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createOAuthFlow } from './apps/api/dist/credentials/flow.js';
import { createHttpOAuthProvider } from './apps/api/dist/credentials/provider.js';
import { createListener } from './apps/api/dist/http.js';
import { createMemoryCredentialsPort } from './apps/api/dist/ports/memory/credentials.js';
import { createOAuthConnectRoute, createOAuthRevokeRoute } from './apps/api/dist/routes/oauth.js';
import { createOAuthConnectionsReadRoute } from './apps/api/dist/routes/oauth-connections-read.js';
import { createOAuth } from './packages/fakes/dist/fake-oauth.js';
import { listen } from './packages/fakes/dist/http.js';

const remote = await listen(createOAuth(), 0);
const api = createServer();
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const { createWebServer } = await import('./apps/web/dist/src/server.js');
let web = createWebServer({ apiUrl: 'http://127.0.0.1:' + api.address().port }).listen(0, '127.0.0.1');
await once(web, 'listening');
const webUrl = 'http://127.0.0.1:' + web.address().port;
const grants = new Map();
const credentials = createMemoryCredentialsPort();
const flow = createOAuthFlow({
  credentials,
  grants: {
    save: (grant) => { grants.set(grant.state, grant); return Promise.resolve(); },
    read: (state) => Promise.resolve(grants.get(state)),
    consume: (state) => { const grant = grants.get(state); grants.delete(state); return Promise.resolve(grant); },
  },
  provider: createHttpOAuthProvider(remote.url, webUrl + '/oauth/callback'),
  ledger: { read: () => Promise.resolve(undefined), transition: () => Promise.reject(new Error('unused')) },
  now: () => new Date(),
});
const deps = { flow, subject: (headers) => headers['x-goog-iap-jwt-assertion'] };
let unavailable = false;
const read = createOAuthConnectionsReadRoute({
  verify: async (assertion) => ({ sub: assertion }),
  read: async (subject) => {
    const connection = await credentials.read(subject, 'google');
    return connection === undefined ? [] : [{ provider: connection.provider, scope: connection.scope, status: connection.status, expiresAt: connection.expiresAt }];
  },
  now: () => new Date(),
});
api.on('request', createListener({
  'GET /v1/oauth/connections': (request) => unavailable ? Promise.resolve({ status: 503, body: { error: 'unavailable' } }) : read(request),
  'POST /v1/oauth/connections/google': createOAuthConnectRoute(deps),
  'DELETE /v1/oauth/connections/google': createOAuthRevokeRoute(deps),
}));
process.on('message', async (command) => {
  if (command === 'restart') {
    const port = web.address().port;
    await new Promise((resolve) => web.close(resolve));
    web = createWebServer({ apiUrl: 'http://127.0.0.1:' + api.address().port }).listen(port, '127.0.0.1');
    await once(web, 'listening');
  } else if (command === 'unavailable' || command === 'available') {
    unavailable = command === 'unavailable';
  } else {
    const connection = await credentials.read('alice', 'google');
    await credentials.save({ ...connection, ...(command === 'expired' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : { status: command }) });
  }
  process.send('ready');
});
process.send(webUrl);
`;

test.beforeAll(async () => {
  fixture = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const ready = once(fixture, 'message').then(([url]) => String(url));
  const exited = once(fixture, 'exit').then(() => {
    throw new Error('OAuth fixture exited before readiness; run pnpm build first.');
  });
  webUrl = await Promise.race([ready, exited]);
});

test.afterAll(async () => {
  if (fixture.exitCode === null) {
    const exited = once(fixture, 'exit');
    fixture.kill();
    await exited;
  }
});

test('oauth.connect-disconnect', async ({ page, context }) => {
  await page.goto(`${webUrl}/connections`);
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  const started = Date.now();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('active');
  await expect(page).toHaveURL(/\/connections$/);
  const connectMs = Date.now() - started;
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('active');
  await context.clearCookies();
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('active');
  await control('restart');
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('active');
  await expect(
    page.getByText('Scope: https://www.googleapis.com/auth/drive.readonly', { exact: true }),
  ).toBeVisible();
  const disconnectStarted = Date.now();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('revoked');
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  const disconnectMs = Date.now() - disconnectStarted;
  await test.info().attach('metrics.json', {
    body: JSON.stringify({
      durationsMs: [connectMs, disconnectMs],
      p95Ms: Math.max(connectMs, disconnectMs),
    }),
    contentType: 'application/json',
  });
  expect(connectMs).toBeLessThanOrEqual(3000);
  expect(disconnectMs).toBeLessThanOrEqual(3000);
});

for (const status of ['revoked', 'expired'] as const) {
  test(`oauth.connection-${status}`, async ({ page }) => {
    await page.goto(`${webUrl}/connections`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('active');
    await control(status);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText(status);
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    if (status === 'expired') {
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await expect(page.getByRole('status')).toHaveText('revoked');
    }
  });
}

test('oauth.connection-unavailable', async ({ page }) => {
  await page.goto(`${webUrl}/connections`);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('active');
  await control('unavailable');
  try {
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Connection status unavailable');
    await expect(page.getByRole('alert')).toHaveText(
      'Could not load connections. Refresh to try again.',
    );
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
  } finally {
    await control('available');
  }
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('active');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('revoked');
});

async function control(command: string): Promise<void> {
  const ready = once(fixture, 'message');
  fixture.send(command);
  await ready;
}
