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
import { createOAuth } from './packages/fakes/dist/fake-oauth.js';
import { listen } from './packages/fakes/dist/http.js';

const remote = await listen(createOAuth(), 0);
const api = createServer();
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const { createWebServer } = await import('./apps/web/dist/src/server.js');
const web = createWebServer({ apiUrl: 'http://127.0.0.1:' + api.address().port }).listen(0, '127.0.0.1');
await once(web, 'listening');
const webUrl = 'http://127.0.0.1:' + web.address().port;
const grants = new Map();
const flow = createOAuthFlow({
  credentials: createMemoryCredentialsPort(),
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
api.on('request', createListener({
  'POST /v1/oauth/connections/google': createOAuthConnectRoute(deps),
  'DELETE /v1/oauth/connections/google': createOAuthRevokeRoute(deps),
}));
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

test('oauth.connect-disconnect', async ({ page }) => {
  await page.goto(`${webUrl}/connections`);
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  const started = Date.now();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('active');
  await expect(page).toHaveURL(/\/connections$/);
  const connectMs = Date.now() - started;
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('active');
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
