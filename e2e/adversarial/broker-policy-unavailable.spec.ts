import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.broker-policy-unavailable', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  const variants = await cases('dependency-unavailable');
  expect(new Set(variants.map((row) => row.fault))).toEqual(
    new Set(['policy-unavailable', 'broker-unavailable']),
  );
  for (const row of variants) {
    const world = await runtimeApi.createBrokerWorld({
      policyUnavailable: row.fault === 'policy-unavailable',
      brokerUnavailable: row.fault === 'broker-unavailable',
    });
    await expect(world.broker.execute(world.input)).rejects.toThrow('unavailable');
    expect(world.effects.attempts()).toBe(0);
    expect(world.effects.receipts()).toEqual([]);
    const observation = await runtimeApi.runCase(row);
    expect(observation.calls[0].outcome).toBe('denied');
    await assertSafe(page, testInfo, row, observation);
  }
});
