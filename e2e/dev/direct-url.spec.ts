import { writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { requireDevPlaywrightConfig, resolveDevApiUrl } from '../playwright.dev.config.js';

const devConfig = requireDevPlaywrightConfig(process.env);

const ALLOWED_IAP_BLOCK_STATUSES = [302, 303, 307, 308, 401, 403] as const;
const ALLOWED_INTERNAL_API_BLOCK_STATUSES = [401, 403, 404] as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

type ProbeObservation = {
  readonly label: string;
  readonly target: string;
  readonly status: number | 'unreachable';
  readonly blocked: boolean;
};

// Direct Run URL bypasses are hard failures: never mask with retries.
test.describe.configure({ retries: 0 });

test.describe('dev direct Cloud Run URL and internal API boundary', () => {
  test('sec.direct-run-url-blocked', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const baseURL = devConfig.use?.baseURL;
    expect(baseURL).toBeTruthy();

    const observations: ProbeObservation[] = [];

    // 1. Unauthenticated requests to aw-web run.app URL must be blocked by IAP (401/403 or IAP redirect, never 200).
    for (const path of ['/', '/healthz']) {
      const response = await page.request.get(`${baseURL}${path}`, {
        headers: {},
        maxRedirects: 0,
      });
      const status = response.status();
      const body = await response.text();
      expect(status, `Unauthenticated GET ${path} on aw-web must never return 200`).not.toBe(200);
      expect(
        ALLOWED_IAP_BLOCK_STATUSES,
        `Unauthenticated GET ${path} on aw-web must return 401/403 or IAP redirect (got ${status})`,
      ).toContain(status);
      expect(body).not.toContain('<form method="post" action="/">');
      observations.push({
        label: `unauthenticated GET ${path}`,
        target: `${baseURL}${path}`,
        status,
        blocked: true,
      });
    }

    // 2. Requests without IAP token but with forged identity headers must be blocked by IAP.
    const forgedResponse = await page.request.post(`${baseURL}/`, {
      headers: {
        'x-goog-authenticated-user-email': 'accounts.google.com:mallory@example.test',
        'x-goog-iap-jwt-assertion': 'forged.invalid.assertion',
        'x-fake-user': 'alice',
      },
      form: {
        question: 'Attempt forged bypass',
        requestId: '00000000-0000-4000-8000-000000000001',
      },
      maxRedirects: 0,
    });
    const forgedStatus = forgedResponse.status();
    const forgedBody = await forgedResponse.text();
    expect(forgedStatus, 'Forged-header POST / without IAP token must never return 200').not.toBe(
      200,
    );
    expect(ALLOWED_IAP_BLOCK_STATUSES).toContain(forgedStatus);
    expect(forgedBody).not.toContain('aria-label="Citations"');
    observations.push({
      label: 'forged headers POST / without IAP token',
      target: `${baseURL}/`,
      status: forgedStatus,
      blocked: true,
    });

    // 3. aw-api is INGRESS_TRAFFIC_INTERNAL_ONLY and invoker-restricted to aw-web/aw-scheduler:
    // direct public internet requests to its Run URL must be unreachable or return 401/403/404, never 200.
    const apiRunUrl = resolveDevApiUrl(process.env);
    expect(
      apiRunUrl,
      'Set AW_DEV_API_URL when AW_DEV_URL does not use the standard aw-web-* Cloud Run hostname',
    ).toBeTruthy();

    for (const variant of [
      { label: 'unauthenticated direct API POST /v1/ask', headers: {} },
      {
        label: 'forged assertion direct API POST /v1/ask',
        headers: {
          'x-goog-authenticated-user-email': 'accounts.google.com:mallory@example.test',
          'x-goog-iap-jwt-assertion': 'forged.invalid.assertion',
        },
      },
    ]) {
      let apiStatus: number | 'unreachable' = 'unreachable';
      try {
        const apiResponse = await page.request.post(`${apiRunUrl}/v1/ask`, {
          headers: variant.headers,
          data: {
            question: 'Direct internal API probe',
            requestId: '00000000-0000-4000-8000-000000000002',
          },
          maxRedirects: 0,
          timeout: 15_000,
        });
        apiStatus = apiResponse.status();
      } catch (error) {
        // Only a refused or timed-out connection counts as "unreachable"; a DNS failure
        // (mistyped host) or TLS/context error must fail the test, not pass it.
        if (!/ECONNREFUSED|ECONNRESET|ETIMEDOUT/.test(String(error))) throw error;
        apiStatus = 'unreachable';
      }
      expect(apiStatus, `${variant.label} must never return 200`).not.toBe(200);
      if (typeof apiStatus === 'number') {
        expect(
          ALLOWED_INTERNAL_API_BLOCK_STATUSES,
          `${variant.label} must return 401/403/404 when reachable at HTTP edge (got ${apiStatus})`,
        ).toContain(apiStatus);
      }
      observations.push({
        label: variant.label,
        target: `${apiRunUrl}/v1/ask`,
        status: apiStatus,
        blocked: true,
      });
    }

    const report = {
      test: 'sec.direct-run-url-blocked',
      status: 'PASSED',
      webUrl: baseURL,
      apiRunUrl,
      observations,
    };
    const evidencePath = testInfo.outputPath('direct-url-evidence.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright allocates testInfo.outputPath
    await writeFile(evidencePath, JSON.stringify(report, null, 2));
    await testInfo.attach('direct-url-evidence.json', {
      path: evidencePath,
      contentType: 'application/json',
    });
    await page.setContent(
      `<main><h1>sec.direct-run-url-blocked</h1><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></main>`,
    );
    await expect(page.getByRole('heading', { name: 'sec.direct-run-url-blocked' })).toBeVisible();
  });
});
