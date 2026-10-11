import { expect, test } from '@playwright/test';

import { createRoleResolver } from '../../apps/api/src/auth/directory.ts';
import { createDirectory } from '../../packages/fakes/src/fake-directory.ts';
import { listen } from '../../packages/fakes/src/http.ts';

const seededObservedAt = '2026-01-01T00:00:00.000Z';
const seededObservedMs = Date.parse(seededObservedAt);
const oneDayMs = 86_400_000;

let directoryUrl = '';
let closeDirectory: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const directory = await listen(createDirectory(), 0);
  directoryUrl = directory.url;
  closeDirectory = directory.close;
});

test.afterAll(async () => {
  await closeDirectory?.();
});

test('sec.stale-groups', async ({ page }) => {
  await page.goto(`${directoryUrl}/snapshots/bob`);
  await expect(page.locator('body')).toContainText('agent-users@company.example');
  const snapshot: unknown = await (await page.request.get(`${directoryUrl}/snapshots/bob`)).json();
  expect(snapshot).toEqual({
    sub: 'bob',
    groups: ['agent-users@company.example'],
    observedAt: seededObservedAt,
  });

  const rolesAtObservation = await createRoleResolver({
    baseUrl: directoryUrl,
    now: () => seededObservedMs,
  })('bob');
  expect(rolesAtObservation).toEqual(['Employee']);

  const rolesOneDayLater = await createRoleResolver({
    baseUrl: directoryUrl,
    now: () => seededObservedMs + oneDayMs,
  })('bob');
  expect(rolesOneDayLater).toEqual([]);

  const rolesNow = await createRoleResolver({ baseUrl: directoryUrl })('bob');
  expect(rolesNow).toEqual([]);

  await page.evaluate(
    (evidence) => {
      const pre = document.createElement('pre');
      pre.textContent = evidence;
      document.body.replaceChildren(pre);
    },
    JSON.stringify({ snapshot, rolesAtObservation, rolesOneDayLater, rolesNow }, null, 2),
  );
});
