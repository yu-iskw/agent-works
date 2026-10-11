import { expect, it } from 'vitest';

import { BROKER_BUDGET_MS, measureBroker } from './broker.bench.js';

it('keeps an approved broker call under 60 ms at p95', async () => {
  expect(await measureBroker()).toBeLessThanOrEqual(BROKER_BUDGET_MS);
});
