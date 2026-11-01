import { expect } from '@playwright/test';

import { JOURNEYS, runJourney, test } from './steps.js';

test.use({ journey: JOURNEYS[6] });

test('journey 6: engineering, beta, dark, reviewed plan', async ({ page, journey }) => {
  const record = await runJourney(page, journey);
  expect(record.revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(record.plan?.version).toBe(1);
});
