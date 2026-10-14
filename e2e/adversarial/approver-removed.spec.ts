import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.approver-removed', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  const world = await runtimeApi.createBrokerWorld();
  world.removeReviewer();
  const decision = await world.broker.bindApproval(world.input.approvalId, {
    actorSub: 'bob',
    decision: 'approve',
    expectedPayloadSha256: world.digest,
  });
  expect(decision.ok).toBe(false);
  expect(world.effects.attempts()).toBe(0);
  for (const row of await cases('approver-removed')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.diagnostics).toEqual(['APPROVAL_REQUIRED']);
    await assertSafe(page, testInfo, row, observation);
  }
});
