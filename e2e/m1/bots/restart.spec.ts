import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { db } from '../helpers.js';

import { openBot, requestDesign } from './helpers.js';

async function control(operation: 'restart' | 'count', key: string): Promise<number> {
  const request = 'artifacts/m1/bot-control-request.json';
  const result = 'artifacts/m1/bot-control-result.json';
  if (existsSync(result)) unlinkSync(result);
  writeFileSync(`${request}.tmp`, JSON.stringify({ operation, key }));
  renameSync(`${request}.tmp`, request);
  await expect.poll(() => existsSync(result), { timeout: 60_000 }).toBe(true);
  const reply = JSON.parse(readFileSync(result, 'utf8')) as {
    operation: string;
    count?: number;
    error?: string;
  };
  expect(reply.error).toBeUndefined();
  expect(reply.operation).toBe(operation);
  if (reply.count === undefined) throw new Error('Reference submit count missing');
  return reply.count;
}

test('a pending MCP task survives segment restart without another submit', async ({ page }) => {
  test.setTimeout(360_000);
  await openBot(page);
  await requestDesign(page, '[slow-agent]');
  await expect(page.getByRole('heading', { name: /Review draft revision/ })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm and publish this revision' }).click();
  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page.getByRole('heading', { name: 'Bot run' })).toBeVisible();
  const taskId = page.url().split('/').at(-1);
  if (!taskId) throw new Error('Run URL missing task id');
  let key = '';
  await expect
    .poll(
      async () => {
        const rows = await db('alpha')<
          { idempotency_key: string | null; status: string; external: { handle?: string } | null }[]
        >`
      select idempotency_key, status, external from tw_bot_steps where task_id=${taskId} and step_id='research'`;
        const step = rows[0];
        if (step?.status === 'waiting_external' && step.idempotency_key && step.external?.handle) {
          key = step.idempotency_key;
          return true;
        }
        return false;
      },
      { timeout: 120_000, intervals: [50] },
    )
    .toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(25_000);
  expect(await control('restart', key)).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(30_000);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 240_000, intervals: [1000] });
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('completed', { exact: true })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 120_000, intervals: [1000] });
  expect(await control('count', key)).toBe(1);
});
