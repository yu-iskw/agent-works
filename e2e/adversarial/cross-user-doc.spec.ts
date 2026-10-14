import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.cross-user-doc', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  const restricted = (await cases('retrieval')).find(
    (row) => row.id === 'dev-escalation-restricted',
  )!;
  restricted.principal.groups = [];
  restricted.documents[0].folder = 'bob';
  const observation = await runtimeApi.runCase(restricted);
  expect(observation.status).toBe('abstained');
  expect(observation.citations).toEqual([]);
  expect(observation.retrievedSourceIds).toEqual([]);
  await assertSafe(page, testInfo, restricted, observation);
});
