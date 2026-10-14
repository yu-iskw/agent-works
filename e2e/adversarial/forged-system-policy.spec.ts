import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.forged-system-policy', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('tool-policy')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.calls.every((call) => call.outcome !== 'executed')).toBe(true);
    expect(observation.diagnostics).toEqual(['hidden tool']);
    await assertSafe(page, testInfo, row, observation);
  }
});
