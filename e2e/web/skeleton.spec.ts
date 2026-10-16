import { expect, test } from '@playwright/test';

import { psql } from './db.js';

const question = 'What are the triage runbook steps?';

test.use({ baseURL: 'http://127.0.0.1:8081', extraHTTPHeaders: { 'x-fake-user': 'alice' } });
test.describe.configure({ mode: 'serial' });

test('skeleton.sign-in-ask-cite-audit', async ({ page }) => {
  expect(psql('select count(*) from audit_events'), 'stack is not fresh, run pnpm dev:reset').toBe(
    '0',
  );
  await page.goto('/');
  await page.getByLabel('Question').fill(question);
  const posted = page.waitForRequest(
    (incoming) =>
      incoming.method() === 'POST' && new URL(incoming.url()).pathname.endsWith('/api/ask'),
  );
  await page.getByRole('button', { name: 'Ask' }).click();
  const requestId = ((await posted).postDataJSON() as { requestId: string }).requestId;

  const citations = page.getByRole('list', { name: 'Citations' });
  await expect(citations.getByRole('link', { name: 'Triage runbook' })).toHaveAttribute(
    'href',
    'https://drive.fake.test/d/alice-runbook',
  );
  expect(psql('select count(*) from audit_events')).toBe('1');
  expect(psql('select initiator_subject from audit_events')).toBe('alice');

  const replay = await page.request.post('/api/ask', { data: { question, requestId } });
  expect(replay.status()).toBe(409);
  expect(psql('select count(*) from audit_events')).toBe('1');
});

test('skeleton.submit-to-citation-p95', async ({ page }) => {
  const durationsMs: number[] = [];
  for (let sample = 0; sample < 10; sample += 1) {
    await page.goto('/');
    await page.getByLabel('Question').fill(question);
    const started = Date.now();
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByRole('link', { name: 'Triage runbook' })).toBeVisible();
    durationsMs.push(Date.now() - started);
  }
  const p95Ms = percentile(durationsMs, 95);
  await test.info().attach('metrics.json', {
    body: JSON.stringify({ durationsMs, p95Ms }),
    contentType: 'application/json',
  });
  expect(p95Ms).toBeLessThan(3000);
});

function percentile(samples: readonly number[], percentileRank: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = (percentileRank / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const low = sorted.at(lower) ?? 0;
  const high = sorted.at(upper) ?? low;
  if (lower === upper) return low;
  return low * (upper - index) + high * (index - lower);
}
