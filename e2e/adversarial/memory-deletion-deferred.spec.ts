import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.memory-deletion-deferred', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('memory-deletion')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.status).toBe('deferred');
    expect(observation.workflow).toBe('deferred');
    expect(observation.calls).toEqual([]);
    await assertSafe(page, testInfo, row, observation);
  }
  // Lifecycle deletion is deliberately absent; P4-MEM must not be filed by this bundle.
  const row = (await cases('memory-deletion'))[0];
  const observation = await runtimeApi.runCase(row);
  test.fail(
    true,
    'https://github.com/yu-iskw/agent-works/issues/133 — RFC P4-MEM is not filed; item and derivative lifecycle evidence is deferred',
  );
  expect(observation.status).toBe('denied');
});
