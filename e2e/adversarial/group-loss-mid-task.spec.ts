import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.group-loss-mid-task', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('group-loss')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.retrievedSourceIds).toEqual([]);
    expect(observation.calls).toEqual([
      {
        tool: 'drive.search',
        arguments: { query: row.question },
        authorized: false,
        outcome: 'denied',
      },
    ]);
    await assertSafe(page, testInfo, row, observation);
  }
});
