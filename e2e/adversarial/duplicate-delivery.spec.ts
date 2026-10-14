import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.duplicate-delivery', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  const world = await runtimeApi.createBrokerWorld();
  world.effects.loseNextResponse();
  await expect(world.broker.execute(world.input)).rejects.toThrow('response lost');
  expect(world.effects.receipts()).toHaveLength(1);
  const resumed = await world.broker.execute(world.input);
  expect(resumed).toMatchObject({ ok: true, replay: false });
  const replayed = await world.broker.execute(world.input);
  expect(replayed).toMatchObject({ ok: true, replay: true });
  expect(world.effects.receipts()).toHaveLength(1);
  expect(world.effects.attempts()).toBe(2);
  expect(await world.store.read(world.input.approvalId)).toMatchObject({ executionsUsed: 1 });
  const duplicate = await world.broker.execute({ ...world.input, id: 'different-call' });
  expect(duplicate).toMatchObject({ ok: false, code: 'DUPLICATE_CALL' });
  expect(world.effects.receipts()).toHaveLength(1);
  for (const row of await cases('duplicate-delivery')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.workflow).toBe('replayed');
    expect(observation.diagnostics).toEqual(['resources:1']);
    await assertSafe(page, testInfo, row, observation);
  }
});
