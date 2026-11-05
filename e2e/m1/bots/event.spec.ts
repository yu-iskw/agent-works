import { createHmac, randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { db } from '../helpers.js';

import { openBot, requestDesign } from './helpers.js';

test('a signed event delivered twice starts one visible run', async ({ page }) => {
  test.setTimeout(180_000);
  const id = await openBot(page);
  await requestDesign(page, '[event:m1-test:changed]');
  await expect(page.getByRole('heading', { name: /Review draft revision/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and publish this revision' }).click();

  const event = {
    triggerId: 'changed',
    source: 'm1-test',
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    keyId: 'm1-bots-test-only',
    body: Buffer.from('{}'),
  };
  const bytes = Buffer.concat([
    Buffer.from(
      `aw-event-v1\n${[event.triggerId, event.source, event.eventId, event.timestamp, event.keyId].join('\n')}\n`,
    ),
    event.body,
  ]);
  const signature = createHmac('sha256', 'm1-bots-development-only-test-key')
    .update(bytes)
    .digest('hex');
  const send = () =>
    page.request.post('http://api-alpha:8080/v1/teamwork/bot-events', {
      data: { ...event, signature },
    });
  const first = await send();
  expect(first.status()).toBe(202);
  const started = await first.json();
  expect(started.outcome).toBe('started');
  const second = await send();
  expect(second.status()).toBe(202);
  expect((await second.json()).outcome).toBe('duplicate');
  const rows = await db('alpha')<{ task_id: string }[]>`
    select task_id from tw_bot_runs where teammate_id=${id} and trigger_ref=${`event:m1-test:${event.eventId}`}`;
  expect(rows).toHaveLength(1);
  await page.goto(`/s/alpha/bots/${id}`);
  await expect(page.locator(`a[href$="/bot-runs/${rows[0]?.task_id}"]`)).toHaveCount(1);
  await page.goto(`/s/alpha/bot-runs/${rows[0]?.task_id}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 120_000, intervals: [1000] });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [1000] });
});
