import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import type * as Directory from '../../apps/api/src/auth/directory.js';
import type * as Auth from '../../apps/api/src/auth/iap.js';
import type * as Http from '../../apps/api/src/http.js';
import type * as Memory from '../../apps/api/src/ports/memory/suspension-ledger.js';
import type * as Change from '../../apps/api/src/routes/admin-change.js';
import type * as Read from '../../apps/api/src/routes/admin-read.js';
import type * as Web from '../../apps/web/src/server.js';
import type { Server } from 'node:http';

async function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return `http://127.0.0.1:${address.port}`;
}
function close(server: Server): Promise<void> {
  return new Promise((done) => server.close(() => done()));
}
async function world() {
  const auth = await load<typeof Auth>('apps/api/dist/auth/iap.js');
  const directory = await load<typeof Directory>('apps/api/dist/auth/directory.js');
  const http = await load<typeof Http>('apps/api/dist/http.js');
  const memory = await load<typeof Memory>('apps/api/dist/ports/memory/suspension-ledger.js');
  const change = await load<typeof Change>('apps/api/dist/routes/admin-change.js');
  const read = await load<typeof Read>('apps/api/dist/routes/admin-read.js');
  const webModule = await load<typeof Web>('apps/web/dist/src/server.js');
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'admin-local', alg: 'ES256' };
  let admin = true;
  const trusted = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/jwks') response.end(JSON.stringify({ keys: [jwk] }));
    else {
      const sub = request.url?.split('/').at(-1);
      response.end(
        JSON.stringify({
          sub,
          observedAt: new Date().toISOString(),
          groups:
            sub === 'alice' && admin
              ? ['agent-admins@company.example']
              : ['agent-users@company.example'],
        }),
      );
    }
  });
  const trustedUrl = await listen(trusted);
  const verify = auth.createIapVerifier({
    jwksUrl: `${trustedUrl}/jwks`,
    issuer: 'https://fake-iap.local',
    audience: 'agent-works-dev',
  });
  const ledger = memory.createMemorySuspensionLedger();
  const deps = {
    verify,
    ledger,
    rolesFor: directory.createRoleResolver({ baseUrl: trustedUrl }),
    now: () => new Date(),
  };
  const api = createServer(
    http.createListener({ ...read.adminReadRoutes(deps), ...change.adminChangeRoutes(deps) }),
  );
  const apiUrl = await listen(api);
  const web = webModule.createWebServer({ apiUrl });
  const webUrl = await listen(web);
  const previousOrigins = process.env.ADMIN_TRUSTED_ORIGINS;
  process.env.ADMIN_TRUSTED_ORIGINS = webUrl;
  function assertion(sub: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'admin-local' })).toString(
      'base64url',
    );
    const body = Buffer.from(
      JSON.stringify({
        sub,
        iss: 'https://fake-iap.local',
        aud: 'agent-works-dev',
        iat: Date.now() / 1000,
        exp: Date.now() / 1000 + 300,
      }),
    ).toString('base64url');
    const input = `${header}.${body}`;
    return `${input}.${sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  return {
    webUrl,
    apiUrl,
    ledger,
    assertion,
    revokeAdmin: () => {
      admin = false;
    },
    close: async () => {
      if (previousOrigins === undefined) delete process.env.ADMIN_TRUSTED_ORIGINS;
      else process.env.ADMIN_TRUSTED_ORIGINS = previousOrigins;
      await close(web);
      await close(api);
      await close(trusted);
    },
  };
}

test('admin local stack suspend, confirm, audit, resume', async ({ page }) => {
  const app = await world();
  try {
    await page.setExtraHTTPHeaders({ 'x-goog-iap-jwt-assertion': app.assertion('alice') });
    await page.goto(`${app.webUrl}/admin`);
    await expect(page.getByRole('heading', { name: 'Suspension control plane' })).toBeVisible();
    await expect(page.getByText('Operator drill has not run.', { exact: false })).toBeVisible();
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Review suspension' }) });
    await form.getByLabel('Target ID (global uses *)').fill('*');
    await form.getByLabel('Suspension reason').fill('Local smoke stop');
    await form.getByRole('button', { name: 'Review suspension' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm admin change' })).toBeVisible();
    expect(await app.ledger.history()).toHaveLength(0);
    await page.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toHaveText('Admin change saved.');
    expect(await app.ledger.history()).toHaveLength(1);
    const resume = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Review resume' }) });
    await resume.getByLabel('Resume reason').fill('Local smoke recovered');
    await resume.getByRole('button', { name: 'Review resume' }).click();
    await page.getByRole('button', { name: 'Confirm change' }).click();
    await expect(page.getByRole('status')).toHaveText('Admin change saved.');
    expect((await app.ledger.snapshot()).suspensions[0].suspended).toBe(false);
    expect((await app.ledger.history()).map((event) => event.eventType)).toEqual([
      'admin.suspend',
      'admin.resume',
    ]);
  } finally {
    await app.close();
  }
});
test('admin local stack forged role is 403 and directory revocation prevents final apply', async ({
  page,
  request,
}) => {
  const app = await world();
  try {
    const forged = await request.get(`${app.apiUrl}/v1/admin/suspensions`, {
      headers: { 'x-goog-iap-jwt-assertion': app.assertion('bob'), 'x-role': 'Admin' },
    });
    expect(forged.status()).toBe(403);
    await page.setExtraHTTPHeaders({ 'x-goog-iap-jwt-assertion': app.assertion('alice') });
    await page.goto(`${app.webUrl}/admin`);
    const form = page
      .locator('form')
      .filter({ has: page.getByRole('button', { name: 'Review suspension' }) });
    await form.getByLabel('Target ID (global uses *)').fill('*');
    await form.getByLabel('Suspension reason').fill('Will be revoked');
    await form.getByRole('button', { name: 'Review suspension' }).click();
    app.revokeAdmin();
    const response = page.waitForResponse((result) => result.url().endsWith('/admin/apply'));
    await page.getByRole('button', { name: 'Confirm change' }).click();
    expect((await response).status()).toBe(403);
    expect(await app.ledger.history()).toHaveLength(0);
  } finally {
    await app.close();
  }
});
