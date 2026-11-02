import { expect } from '@playwright/test';

import { JOURNEYS, runJourney, test } from './steps.js';

test.use({ journey: JOURNEYS[2] });

test('journey 2: metrics, alpha, dark, manual', async ({ page, journey }) => {
  const record = await runJourney(page, journey);
  expect(record.revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(record.assignments).toHaveLength(2);
});
