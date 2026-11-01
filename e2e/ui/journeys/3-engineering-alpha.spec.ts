import { expect } from '@playwright/test';

import { JOURNEYS, runJourney, test } from './steps.js';

test.use({ journey: JOURNEYS[3] });

test('journey 3: engineering, alpha, light, manual, with a member file', async ({
  page,
  journey,
}) => {
  const record = await runJourney(page, journey);
  expect(record.revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(record.assignments).toHaveLength(2);
});
