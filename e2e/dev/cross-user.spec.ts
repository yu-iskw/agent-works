import { writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import {
  evaluateCrossUserProbe,
  requireDevPlaywrightConfig,
  resolveCrossUserResourceConfig,
} from '../playwright.dev.config.js';

import type { TestInfo } from '@playwright/test';

const devConfig = requireDevPlaywrightConfig(process.env);

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function attachEvidence(
  page: { setContent(html: string): Promise<void> },
  testInfo: TestInfo,
  report: Record<string, unknown>,
): Promise<void> {
  const evidencePath = testInfo.outputPath('cross-user-evidence.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright allocates testInfo.outputPath
  await writeFile(evidencePath, JSON.stringify(report, null, 2));
  await testInfo.attach('cross-user-evidence.json', {
    path: evidencePath,
    contentType: 'application/json',
  });
  await page.setContent(
    `<main><h1>sec.cross-user-leak</h1><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></main>`,
  );
}

// Cross-user disclosure is a hard failure: never mask it with retries.
test.describe.configure({ retries: 0 });

test.describe('dev cross-user isolation behind IAP', () => {
  test('sec.cross-user-leak', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const baseURL = devConfig.use?.baseURL;
    expect(baseURL).toBeTruthy();

    const tokenA = process.env.AW_DEV_ID_TOKEN_A?.trim() ?? '';
    const tokenB = process.env.AW_DEV_ID_TOKEN_B?.trim() ?? '';

    // 1. Verify both User A and User B pass the IAP front door on GET /.
    const getAResponse = await page.request.get(`${baseURL}/`, {
      headers: { Authorization: `Bearer ${tokenA}` },
      maxRedirects: 0,
    });
    expect(getAResponse.status(), 'User A must be allowed through IAP on GET /').toBe(200);

    const getBResponse = await page.request.get(`${baseURL}/`, {
      headers: { Authorization: `Bearer ${tokenB}` },
      maxRedirects: 0,
    });
    const userBRootStatus = getBResponse.status();
    if (userBRootStatus !== 200) {
      const reason =
        'BLOCKED: Second test identity (User B) could not pass IAP on GET /. Cross-user isolation requires two distinct real test users in the IAP allowlist.';
      testInfo.annotations.push({ type: 'BLOCKED', description: reason });
      await attachEvidence(page, testInfo, {
        test: 'sec.cross-user-leak',
        status: 'BLOCKED',
        userARootStatus: getAResponse.status(),
        userBRootStatus,
        reason,
      });
      expect(userBRootStatus, reason).toBe(200);
      return;
    }

    // 2. aw-web serves the owner-readable, read-only GET /tasks/:id and GET /artifacts/:id
    // (apps/web/app/tasks/handler.ts). Point AW_DEV_USER_A_RESOURCE_PATH at one of User A's
    // records and AW_DEV_USER_A_PRIVATE_CANARY at a string only that record contains. Without
    // both, fail closed as BLOCKED rather than passing vacuously.
    const resourceConfig = resolveCrossUserResourceConfig(process.env);
    if (resourceConfig.status === 'blocked') {
      testInfo.annotations.push({ type: 'BLOCKED', description: resourceConfig.reason });
      await attachEvidence(page, testInfo, {
        test: 'sec.cross-user-leak',
        status: 'BLOCKED',
        userARootStatus: getAResponse.status(),
        userBRootStatus,
        reason: resourceConfig.reason,
      });
      expect(resourceConfig.status, resourceConfig.reason).toBe('ready');
      return;
    }

    const exactResourceUrl = `${baseURL}${resourceConfig.resourcePath}`;

    // 3. POSITIVE CONTROL: User A must read the exact URL on aw-web (HTTP 200) and observe
    // the User-A-specific canary string before we assert User B is denied on that exact URL.
    const userAResponse = await page.request.get(exactResourceUrl, {
      headers: { Authorization: `Bearer ${tokenA}` },
      maxRedirects: 0,
    });
    const userAStatus = userAResponse.status();
    const userABody = await userAResponse.text();

    // 4. NEGATIVE ASSERTION: User B requests the exact same URL on aw-web and must receive
    // HTTP 403 or 404 with no canary and no User A content.
    const userBResponse = await page.request.get(exactResourceUrl, {
      headers: { Authorization: `Bearer ${tokenB}` },
      maxRedirects: 0,
    });
    const userBStatus = userBResponse.status();
    const userBBody = await userBResponse.text();

    // 5. Outsider: no credential and a forged one must be denied on the same URL, and an
    // unguessable id under the same collection must reveal nothing.
    const collection = resourceConfig.resourcePath.split('/').slice(0, 2).join('/');
    const outsiderResponse = await page.request.get(exactResourceUrl, { maxRedirects: 0 });
    const forgedResponse = await page.request.get(exactResourceUrl, {
      headers: { Authorization: 'Bearer forged.invalid.token' },
      maxRedirects: 0,
    });
    const randomResponse = await page.request.get(
      `${baseURL}${collection}/${crypto.randomUUID()}`,
      { headers: { Authorization: `Bearer ${tokenB}` }, maxRedirects: 0 },
    );
    for (const denied of [outsiderResponse, forgedResponse, randomResponse]) {
      expect([302, 401, 403, 404], 'outsider/forged/random must be denied').toContain(
        denied.status(),
      );
      expect(await denied.text(), 'no canary for outsider/forged/random').not.toContain(
        resourceConfig.canary,
      );
    }

    const evaluation = evaluateCrossUserProbe({
      resourcePath: resourceConfig.resourcePath,
      canary: resourceConfig.canary,
      userAStatus,
      userABody,
      userBStatus,
      userBBody,
    });

    if (!evaluation.ok) {
      if (evaluation.status === 'BLOCKED') {
        testInfo.annotations.push({ type: 'BLOCKED', description: evaluation.reason });
      }
      await attachEvidence(page, testInfo, {
        test: 'sec.cross-user-leak',
        status: evaluation.status,
        resourcePath: resourceConfig.resourcePath,
        userAStatus,
        userBStatus,
        reason: evaluation.reason,
      });
      expect(evaluation.ok, evaluation.reason).toBe(true);
      return;
    }

    await attachEvidence(page, testInfo, {
      test: 'sec.cross-user-leak',
      status: 'PASSED',
      resourcePath: resourceConfig.resourcePath,
      positiveControl: {
        userAStatus,
        canaryVerified: true,
      },
      negativeControl: {
        userBStatus,
        canaryLeakedToB: false,
      },
    });
    await expect(page.getByRole('heading', { name: 'sec.cross-user-leak' })).toBeVisible();
  });
});
