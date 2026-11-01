import { expect } from '@playwright/test';

import { JOURNEYS, manualOverlapSoFar, runJourney, test } from './steps.js';

test.use({ journey: JOURNEYS[4] });

test('journey 4: research, beta, dark, manual', async ({ page, journey }) => {
  const record = await runJourney(page, journey);
  expect(record.revisions.map((r) => r.revision)).toEqual([1, 2]);
  expect(record.assignments).toHaveLength(2);
  // Two specialists ran at the same moment in this or an earlier manual journey.
  expect(manualOverlapSoFar(record.overlap, journey.n)).toBe(true);
});
