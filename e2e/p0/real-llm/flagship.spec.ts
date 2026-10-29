import { writeFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  captureElement,
  FLAGSHIP,
  SCREENSHOTS,
  db,
  fixtureDocCount,
  signIn,
  startTask,
  waitForStatus,
  fullShot,
} from '../helpers.js';

// Real Vertex AI. Fails closed: any sign of the stub, or a model other than the one the
// operator authorised, fails the test instead of passing on a fixture.
const expectedModel = process.env.P0_EXPECTED_MODEL ?? 'gemini-3.8-flash';

test('readiness reports the real Vertex model', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(/STUB MODEL/)).toHaveCount(0);
  await page.goto('/connections');
  await expect(page.locator('[data-model-id]')).toHaveText(expectedModel);
  await expect(page.getByText('vertex (real model)')).toBeVisible();
  await fullShot(page, `${SCREENSHOTS}/20-real-connections-1440.png`);
});

test('flagship flow on real Gemini: prompt, evidence, draft, approval, one write', async ({
  page,
}) => {
  await signIn(page);
  await page.screenshot({ path: `${SCREENSHOTS}/21-real-home-1440.png` });
  const id = await startTask(page, FLAGSHIP);
  await expect(page.locator('[data-progress]')).toBeVisible();
  await fullShot(page, `${SCREENSHOTS}/22-real-running-1440.png`);
  await waitForStatus(page, 'waiting_approval', 180_000);
  const meta = page.locator('[data-model-meta]');
  await expect(meta).toContainText('Mode: vertex');
  await expect(meta).toContainText(`Model: ${expectedModel}`);
  await expect(meta).toContainText('Response ID:');
  await expect(page.getByText(/STUB/)).toHaveCount(0);
  await expect(page.locator('[data-evidence]')).toHaveCount(5);
  const evidenceIds = await page
    .locator('[data-evidence]')
    .evaluateAll((items) => items.map((item) => item.getAttribute('data-evidence')));
  const cites = await page
    .locator('a.cite')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(cites.length).toBeGreaterThan(0);
  for (const href of cites)
    expect(evidenceIds.map((evidence) => `#ev-${evidence}`)).toContain(href);
  await expect(page.locator('.cause').first()).toBeVisible();
  await page.locator('#evidence').scrollIntoViewIfNeeded();
  await fullShot(page, `${SCREENSHOTS}/23-real-evidence-approval-1440.png`);
  await captureElement(page, '#report', `${SCREENSHOTS}/24-real-report-draft-1440.png`);

  const rows = await db()`
    select mode, model_id, model_version, response_id, latency_ms, outcome, at
    from wb_model_calls where task_id = ${id} order by id
  `;
  expect(rows).toHaveLength(1);
  const call = rows[0] ?? {};
  expect(call.mode).toBe('vertex');
  expect(call.model_id).toBe(expectedModel);
  expect(String(call.model_version)).toContain(expectedModel);
  expect(call.outcome).toBe('ok');
  expect(String(call.response_id ?? '')).not.toBe('');

  await page.locator('#approval').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Approve and create' }).click();
  await waitForStatus(page, 'completed');
  await fullShot(page, `${SCREENSHOTS}/25-real-success-1440.png`);
  expect(await fixtureDocCount(id)).toBe(1);
  await page.locator('[data-result-link]').click();
  await expect(page.getByRole('heading', { name: 'Simulated Google Doc' })).toBeVisible();
  await page.waitForTimeout(1500);
  writeFileSync(
    'artifacts/p0/real-llm-evidence.json',
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        taskId: id,
        mode: call.mode,
        configuredModel: expectedModel,
        modelVersion: call.model_version,
        responseId: call.response_id,
        latencyMs: call.latency_ms,
        callAt: call.at,
        workspace: 'fixture (simulated)',
      },
      null,
      2,
    )}\n`,
  );
});
