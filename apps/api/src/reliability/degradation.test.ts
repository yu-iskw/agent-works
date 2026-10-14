import { expect, it } from 'vitest';

import { degradation } from './degradation.js';

it('denies writes during broker outages and never invents grounding', () => {
  expect(degradation({ dependency: 'write_broker', fallbackApproved: false }).outcome).toBe(
    'deny_write',
  );
  expect(degradation({ dependency: 'search', fallbackApproved: false }).outcome).toBe('ungrounded');
});
it('uses a fallback only when explicitly approved', () => {
  expect(
    degradation({
      dependency: 'model',
      fallbackApproved: false,
      approvedFallbackModel: 'candidate',
    }).outcome,
  ).toBe('unavailable');
  expect(degradation({ dependency: 'model', fallbackApproved: true }).outcome).toBe('unavailable');
  expect(
    degradation({ dependency: 'model', fallbackApproved: true, approvedFallbackModel: 'approved' }),
  ).toMatchObject({ outcome: 'approved_fallback', model: 'approved' });
});
it('can continue safely without memory personalization', () => {
  expect(degradation({ dependency: 'memory', fallbackApproved: false }).outcome).toBe(
    'without_memory',
  );
});
