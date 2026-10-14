import { expect, test, vi } from 'vitest';

import { offlineCloudScheduler, offlineCloudEvents } from './cloud-stubs.js';
import { scheduleFixture, eventTriggerFixture } from './test-fixtures.js';
test('cloud adapters return typed offline plans and perform no HTTP', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const spec = scheduleFixture();
  expect(await offlineCloudScheduler().register(spec)).toEqual({
    kind: 'offline',
    provider: 'cloud-scheduler',
    resourceId: spec.id,
  });
  expect(await offlineCloudScheduler().remove(spec.id)).toMatchObject({ kind: 'offline' });
  for (const provider of ['pubsub', 'eventarc'] as const) {
    const trigger = eventTriggerFixture(spec.id);
    expect(await offlineCloudEvents(provider).register(trigger)).toMatchObject({
      kind: 'offline',
      provider,
      resourceId: trigger.id,
    });
    expect(await offlineCloudEvents(provider).remove(trigger.id)).toMatchObject({
      kind: 'offline',
      provider,
    });
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
