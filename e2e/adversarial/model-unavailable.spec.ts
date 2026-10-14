import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.model-unavailable', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('model-unavailable')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.diagnostics).toEqual(['llm status']);
    expect(observation.calls).toEqual([]);
    expect(observation.answer).toBe('');
    await assertSafe(page, testInfo, row, observation);
  }
});
