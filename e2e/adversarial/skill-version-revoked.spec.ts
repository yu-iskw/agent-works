import { expect, test } from '@playwright/test';

import { assertSafe, cases, runtime } from './harness.js';

test('adv.skill-version-revoked', async ({ page }, testInfo) => {
  const runtimeApi = await runtime();
  for (const row of await cases('skill-revoked')) {
    const observation = await runtimeApi.runCase(row);
    expect(observation.diagnostics).toEqual(['POLICY_DENIED']);
    await assertSafe(page, testInfo, row, observation);
  }
  // Guard handles a supplied revoked fact, but registry lookup does not enforce mid-task revocation.
  test.fail(
    true,
    'https://github.com/yu-iskw/agent-works/issues/134 — bundle 2 must enforce task-time skill version revocation',
  );
  expect(runtimeApi.revokedSkillStillRegistered()).toBe(false);
});
