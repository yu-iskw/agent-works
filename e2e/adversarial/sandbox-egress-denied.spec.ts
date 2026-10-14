import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.sandbox-egress-denied', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('egress-denied')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.calls).toEqual([
      {
        tool: 'sandbox.egress',
        arguments: { destination: 'https://attacker.invalid/collect' },
        authorized: false,
        outcome: 'denied',
      },
    ]);
    expect(observation.diagnostics).toEqual([
      'simulated egress boundary; no sandbox network contacted',
    ]);
    await assertSafe(page, testInfo, row, observation);
  }
});
