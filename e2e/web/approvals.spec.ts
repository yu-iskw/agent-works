import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import type { Caller } from '../../apps/api/src/auth/iap.js';
import type * as Stores from '../../apps/api/src/broker/approvals.js';
import type * as Http from '../../apps/api/src/http.js';
import type * as Routes from '../../apps/api/src/routes/approvals.js';
import type * as Handler from '../../apps/web/app/approvals/handler.js';
import type * as Domain from '../../packages/domain/src/index.js';
import type { Server } from 'node:http';

const digest = 'a'.repeat(64);
const changedDigest = 'b'.repeat(64);

function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function world() {
  const domain = await load<typeof Domain>('packages/domain/dist/index.js');
  const stores = await load<typeof Stores>('apps/api/dist/broker/approvals.js');
  const routes = await load<typeof Routes>('apps/api/dist/routes/approvals.js');
  const http = await load<typeof Http>('apps/api/dist/http.js');
  const handler = await load<typeof Handler>('apps/web/dist/app/approvals/handler.js');
  const store = stores.createMemoryApprovalStore();
  const approval = domain.approvalSchema.parse({
    id: 'apr-1',
    taskId: 'tsk-1',
    stepId: 'step-1',
    tool: 'tickets.create',
    targetResource: 'PROJ <draft>',
    payloadSha256: digest,
    requestedBySub: 'alice',
    approverSub: null,
    state: 'pending',
    expiresAt: '2099-12-01T00:00:00.000Z',
    maxExecutions: 1,
    executionsUsed: 0,
  });
  await store.save(approval);
  const route = routes.createApprovalsRoute({
    store,
    verify: (assertion) => {
      if (assertion !== 'bob') return Promise.reject(new Error('assertion not forwarded'));
      return Promise.resolve({ sub: 'bob', assertion } as Caller);
    },
    rolesFor: () => Promise.resolve(['Reviewer']),
  });
  const commands: unknown[] = [];
  const api = createServer(
    http.createListener({
      'POST /v1/approvals/apr-1:decide': (request) => {
        commands.push(JSON.parse(request.body.toString('utf8')));
        return route(request);
      },
    }),
  );
  const apiUrl = await listen(api);
  const web = createServer(
    handler.createApprovalsHandler({
      apiUrl,
      readApproval: (id) => store.read(id),
    }),
  );
  const webUrl = await listen(web);
  return {
    store,
    approval,
    commands,
    webUrl,
    close: async () => {
      await close(web);
      await close(api);
    },
  };
}

test.use({ extraHTTPHeaders: { 'x-goog-iap-jwt-assertion': 'bob' } });

test('approval.ui-approve', async ({ page }) => {
  const app = await world();
  try {
    const started = Date.now();
    await page.goto(`${app.webUrl}/approvals/apr-1`);
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    const durationMs = Date.now() - started;
    await test.info().attach('metrics.json', {
      body: JSON.stringify({ durationsMs: [durationMs], p95Ms: durationMs }),
      contentType: 'application/json',
    });
    expect(durationMs).toBeLessThanOrEqual(2000);
    await expect(page.getByText('PROJ <draft>', { exact: true })).toBeVisible();
    await expect(page.getByText(digest, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Approval approved.');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    expect(app.commands).toEqual([
      { kind: 'decide', decision: 'approve', expectedPayloadSha256: digest },
    ]);
    expect(await app.store.read('apr-1')).toMatchObject({
      state: 'approved',
      approverSub: 'bob',
      executionsUsed: 0,
    });
  } finally {
    await app.close();
  }
});

test('approval.ui-stale-digest', async ({ page }) => {
  const app = await world();
  try {
    await page.goto(`${app.webUrl}/approvals/apr-1`);
    await app.store.save({ ...app.approval, payloadSha256: changedDigest });
    const started = Date.now();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('The payload has changed.');
    const durationMs = Date.now() - started;
    await test.info().attach('metrics.json', {
      body: JSON.stringify({ durationsMs: [durationMs], p95Ms: durationMs }),
      contentType: 'application/json',
    });
    expect(durationMs).toBeLessThanOrEqual(2000);
    expect(app.commands).toEqual([
      { kind: 'decide', decision: 'approve', expectedPayloadSha256: digest },
    ]);
    expect(await app.store.read('apr-1')).toMatchObject({ state: 'pending', approverSub: null });
    await expect(page.getByRole('button')).toHaveCount(0);
    await page.getByRole('link', { name: 'Reload approval' }).click();
    await expect(page.getByText(changedDigest, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Approval rejected.');
    expect(await app.store.read('apr-1')).toMatchObject({ state: 'rejected', approverSub: 'bob' });
  } finally {
    await app.close();
  }
});
