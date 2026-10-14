import { createServer } from 'node:http';

import { test, expect } from '@playwright/test';

import { createSchedulesHandler } from './handler.js';
import smokeConfig from './playwright.config.js';
import { scheduleWebRecord } from './test-fixtures.js';

import type { Server } from 'node:http';
test.setTimeout(smokeConfig.timeout ?? 30000);
let server: Server;
let url: string;
const row = scheduleWebRecord();
test.beforeAll(async () => {
  const load: typeof fetch = (input, options) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === '/v1/schedules/preview')
      return Promise.resolve(Response.json({ allowed: true, maxPrivilege: row.spec.maxPrivilege }));
    if (path === '/v1/schedules/change') {
      const body = JSON.parse(typeof options?.body === 'string' ? options.body : '{}') as {
        action: string;
      };
      row.state = body.action === 'pause' ? ('paused' as typeof row.state) : 'active';
      row.revision += 1;
      return Promise.resolve(Response.json(row));
    }
    if (path === '/v1/schedules' && options?.method === 'POST')
      return Promise.resolve(Response.json(row, { status: 201 }));
    return Promise.resolve(Response.json({ schedules: [row] }));
  };
  server = createServer(createSchedulesHandler({ apiUrl: 'http://api.local', fetch: load }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('address');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});
test('schedules list, privilege preview, creation, pause and resume', async ({ page }) => {
  await page.goto(`${url}/schedules`);
  await expect(page.getByRole('heading', { name: 'Scheduled tasks', exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Your schedules' })).toContainText(row.spec.purpose);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Schedule updated.');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByLabel('Schedule specification (JSON)').fill(JSON.stringify(row.spec));
  await page.getByRole('button', { name: 'Preview privileges', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schedule privilege preview' })).toBeVisible();
  await expect(page.getByText('ticket.create', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Schedule created.');
  await expect(page.getByRole('heading', { name: 'Scheduled tasks', exact: true })).toBeVisible();
});
