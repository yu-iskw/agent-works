import { createHmac, randomUUID } from 'node:crypto';

import { expect, test, vi } from 'vitest';

import { createEventIngestor } from './ingestion.js';
import { createLocalKeyRegistry } from './keys.js';
import { createScheduler } from './service.js';
import { signedEventBytes } from './signature.js';
import { eventTriggerFixture, schedulerFixture } from './test-fixtures.js';

import type { SignedEvent } from './signature.js';
const secret = Buffer.alloc(32, 12);
async function fixture() {
  const f = await schedulerFixture();
  const trigger = eventTriggerFixture(f.spec.id);
  await f.scheduler.create(f.spec, 'alice', trigger);
  const keys = createLocalKeyRegistry([
    {
      id: trigger.signingKeyId,
      source: trigger.source,
      algorithm: 'HS256',
      secret,
      revoked: false,
    },
  ]);
  const ingestor = createEventIngestor({
    store: f.store,
    scheduler: f.scheduler,
    keys,
    now: f.clock.now,
  });
  f.clock.advance(60000);
  function signed(
    body = '{"incidentId":"inc-1"}',
    eventId: string = randomUUID(),
    timestamp = f.clock.now().toISOString(),
  ): SignedEvent {
    const event = {
      triggerId: trigger.id,
      source: trigger.source,
      keyId: trigger.signingKeyId,
      eventId,
      timestamp,
      body: Buffer.from(body),
      signature: '',
    };
    event.signature = createHmac('sha256', secret).update(signedEventBytes(event)).digest('hex');
    return event;
  }
  return { ...f, trigger, keys, ingestor, signed };
}

test('a signature cannot be retargeted to a second trigger sharing the same key', async () => {
  const f = await fixture();
  const secondSpec = { ...f.spec, id: randomUUID() };
  // Store registration exercises source authentication independently of creation consent.
  const second = eventTriggerFixture(secondSpec.id);
  await f.store.create(secondSpec, 'alice', '2026-10-14T10:00:00.000Z', second);
  const event = f.signed();
  await expect(f.ingestor.ingest({ ...event, triggerId: second.id })).rejects.toThrow(
    'INVALID_SIGNATURE',
  );
  expect(await f.store.runs(secondSpec.id)).toEqual([]);
  expect(await f.store.received(event.source, event.eventId)).toBeUndefined();
});

test.each([
  '{"incidentId":',
  '["inc-1"]',
  'null',
  '{"incidentId":true}',
  '{"incidentId":"inc-1","authority":"admin"}',
])('correctly signed invalid JSON/schema %# creates no run', async (body) => {
  const f = await fixture();
  const event = f.signed(body);
  await expect(f.ingestor.ingest(event)).rejects.toThrow('INVALID_EVENT_PAYLOAD');
  expect(await f.store.runs(f.spec.id)).toEqual([]);
  expect(await f.store.received(event.source, event.eventId)).toBeUndefined();
});

test('raw body larger than 16KiB is rejected before dispatch', async () => {
  const f = await fixture();
  await expect(f.ingestor.ingest(f.signed('x'.repeat(16385)))).rejects.toThrow('EVENT_TOO_LARGE');
  expect(await f.store.runs(f.spec.id)).toEqual([]);
});

test('inclusive replay boundary is accepted and one millisecond older rejected', async () => {
  const f = await fixture();
  f.clock.advance(300000);
  const now = f.clock.now().getTime();
  const boundary = new Date(now - 300000).toISOString();
  expect((await f.ingestor.ingest(f.signed(undefined, 'boundary', boundary))).status).toBe(
    'accepted',
  );
  await expect(
    f.ingestor.ingest(f.signed(undefined, 'outside', new Date(now - 300001).toISOString())),
  ).rejects.toThrow('REPLAY_WINDOW');
  expect(await f.store.runs(f.spec.id)).toHaveLength(1);
});

test('recovery of an event run never copies hostile evidence into its task', async () => {
  const f = await fixture();
  const dispatch = vi.fn(f.deps.dispatch.accept);
  const scheduler = createScheduler({
    ...f.deps,
    dispatch: { accept: dispatch },
    store: { ...f.store, finish: () => Promise.reject(new Error('receipt unavailable')) },
  });
  const ingestor = createEventIngestor({
    store: f.store,
    scheduler,
    keys: f.keys,
    now: f.clock.now,
  });
  await expect(ingestor.ingest(f.signed())).rejects.toThrow('receipt unavailable');
  expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'dispatching' }]);
  const recoveredDispatch = vi.fn(f.deps.dispatch.accept);
  const recovered = createScheduler({
    ...f.deps,
    owner: 'recovery',
    dispatch: { accept: recoveredDispatch },
  });
  f.clock.advance(30000);
  await recovered.tick();
  expect(await f.store.runs(f.spec.id)).toMatchObject([{ status: 'accepted', fence: 2 }]);
  expect(recoveredDispatch.mock.calls[0][0].request).toEqual(f.spec.task);
  expect(recoveredDispatch.mock.calls[0][0].idempotencyKey).toBe(
    dispatch.mock.calls[0][0].idempotencyKey,
  );
});
