import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

import smokeConfig from './playwright.config.js';
import { createMemoryWebApp } from './runtime.js';
import { webMemoryConsent, webMemoryItem } from './test-fixtures.js';

import type { Server } from 'node:http';
test.setTimeout(smokeConfig.timeout ?? 30000);
let server: Server;
let url: string;
let consent = { ...webMemoryConsent };
let items = [webMemoryItem()];
function applyCommand(path: string, input: RequestInit['body']): void {
  const body = JSON.parse(typeof input === 'string' ? input : '{}') as {
    enabled?: boolean;
    text?: string;
  };
  switch (path) {
    case '/v1/memory/consent':
      consent = { ...consent, enabled: body.enabled === true, revision: consent.revision + 1 };
      if (!consent.enabled) items = [];
      break;
    case '/v1/memory/edit':
      items = items.map((row) => ({
        ...row,
        text: body.text ?? row.text,
        revision: row.revision + 1,
      }));
      break;
    case '/v1/memory/delete':
      items = [];
      break;
  }
}
test.beforeAll(async () => {
  const load: typeof fetch = (input, options) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (options?.method === 'POST') applyCommand(path, options.body);
    return Promise.resolve(
      Response.json(
        path === '/v1/memory/consent'
          ? {
              consent,
              notice: 'Memory is optional. Only your own turns can be remembered.',
              tenantEnabled: true,
            }
          : { items },
      ),
    );
  };
  server = createServer(createMemoryWebApp({ apiUrl: 'http://api.local', fetch: load }));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('address');
  url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
test('inspect revise delete export and opt-out own memories', async ({ page }) => {
  await page.goto(`${url}/memory`);
  await expect(page.getByRole('heading', { name: 'Your memory', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your memories' })).toContainText(
    'Prefer concise answers',
  );
  await page.getByLabel('Memory text').fill('Prefer examples');
  await page.getByRole('button', { name: 'Save revision', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Memory updated.');
  await expect(page.getByRole('heading', { name: 'Memory revision 2' })).toBeVisible();
  const exported = await page.request.get(`${url}/memory/export`);
  expect(((await exported.json()) as { items: { text: string }[] }).items[0].text).toBe(
    'Prefer examples',
  );
  await page.getByRole('button', { name: 'Delete memory', exact: true }).click();
  await expect(page.getByText('No active memories.')).toBeVisible();
  await page.getByRole('button', { name: 'Opt out and delete memories', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable memory', exact: true })).toBeVisible();
});
