import { writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { requireDevPlaywrightConfig } from '../playwright.dev.config.js';

const devConfig = requireDevPlaywrightConfig(process.env);
const question = process.env.AW_DEV_SYNTHETIC_QUESTION ?? 'What are the triage runbook steps?';
const provisionalBudgetMs = 4000;

function sampleCountFromEnv(): number {
  const raw = Number(process.env.AW_DEV_LATENCY_SAMPLES ?? '5');
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(Math.trunc(raw), 10);
}

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

test.describe('dev identity smoke behind IAP', () => {
  test('skeleton.sign-in-ask-cite-audit', async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const baseURL = devConfig.use?.baseURL;
    expect(baseURL).toBeTruthy();

    const tokenA = process.env.AW_DEV_ID_TOKEN_A?.trim() ?? '';
    await page.setExtraHTTPHeaders({
      Authorization: `Bearer ${tokenA}`,
    });

    const durationsMs: number[] = [];
    const totalSamples = sampleCountFromEnv();
    let firstRequestId = '';
    let firstCitationTitle = '';
    let firstCitationHref = '';

    for (let sample = 0; sample < totalSamples; sample += 1) {
      const gotoResponse = await page.goto(`${baseURL}/`);
      expect(gotoResponse?.status(), 'Authenticated User A must pass IAP on GET /').toBe(200);
      await expect(page.getByRole('heading', { name: 'Ask' })).toBeVisible();

      const requestId = await page.locator('input[name=requestId]').inputValue();
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      if (sample === 0) firstRequestId = requestId;

      await page.getByLabel('Question').fill(question);
      const started = Date.now();
      await page.getByRole('button', { name: 'Ask' }).click();

      const citations = page.getByRole('list', { name: 'Citations' });
      await expect(citations).toBeVisible();
      const firstLink = citations.getByRole('link').first();
      await expect(firstLink).toBeVisible();
      durationsMs.push(Date.now() - started);

      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(citations.getByRole('time').first()).toBeVisible();

      if (sample === 0) {
        firstCitationTitle = (await firstLink.textContent())?.trim() ?? '';
        firstCitationHref = (await firstLink.getAttribute('href')) ?? '';
        expect(firstCitationTitle.length).toBeGreaterThan(0);
        expect(firstCitationHref).toMatch(/^https?:\/\//);
      }
    }

    // Verify that the audit event for User A's first ask was durably recorded:
    // POST /v1/ask reserves and commits event_id = requestId in audit_events (and
    // ledger outbox with initiatorSubject = caller.sub). Replaying the same
    // requestId on POST / returns conflict ("That request was already used.").
    const replay = await page.request.post(`${baseURL}/`, {
      headers: {
        Authorization: `Bearer ${tokenA}`,
      },
      form: {
        question,
        requestId: firstRequestId,
      },
    });
    expect(replay.status()).toBe(200);
    const replayHtml = await replay.text();
    expect(
      replayHtml,
      'Replaying requestId must hit the committed audit_events reservation and report that the request was already used',
    ).toContain('That request was already used.');

    const p95Ms = percentile(durationsMs, 95);
    const latencyReport = {
      test: 'skeleton.sign-in-ask-cite-audit',
      samples: durationsMs.length,
      durationsMs,
      p95Ms,
      provisionalBudgetMs,
      withinProvisionalBudget: p95Ms <= provisionalBudgetMs,
      gatingOnFirstRun: false,
      firstRequestId,
      firstCitationTitle,
      firstCitationHref,
    };

    const latencyPath = testInfo.outputPath('submit-to-citation-latency.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright allocates testInfo.outputPath
    await writeFile(latencyPath, JSON.stringify(latencyReport, null, 2));
    await testInfo.attach('submit-to-citation-latency.json', {
      path: latencyPath,
      contentType: 'application/json',
    });
    await testInfo.attach('metrics.json', {
      body: JSON.stringify({
        durationsMs,
        p95Ms,
        provisionalBudgetMs,
        withinProvisionalBudget: p95Ms <= provisionalBudgetMs,
      }),
      contentType: 'application/json',
    });
  });
});
