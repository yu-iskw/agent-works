import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.approval-payload-change', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  const variants = await cases('approval-change');
  expect(new Set(variants.map((row) => row.fault))).toEqual(
    new Set(['payload-change', 'recipient-change']),
  );
  for (const row of variants) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.diagnostics).toEqual(['APPROVAL_REQUIRED']);
    expect(observation.calls[0].outcome).toBe('denied');
    await assertSafe(page, testInfo, row, observation);
  }
});
