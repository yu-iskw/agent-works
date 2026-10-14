import { canonicalPayloadSha256 } from '@agent-works/domain';

import { validEventPayload } from '../../../../packages/domain/dist/event-trigger-payload.js';
import { sourceEventKey } from '../../../../packages/domain/dist/event-trigger.js';
import { scheduleRunId } from '../../../../packages/domain/dist/schedule-run.js';

import { ScheduleDenied } from './authority.js';
import { verifyEventSignature } from './signature.js';

import type { SigningKeyRegistry } from './keys.js';
import type { Scheduler } from './service.js';
import type { SignedEvent } from './signature.js';
import type { ScheduleRun } from '../../../../packages/domain/dist/schedule-run.js';
import type { SchedulePort } from '../ports/schedule-port.js';
export type EventIngestor = { ingest(event: SignedEvent): Promise<ScheduleRun> };
export function createEventIngestor(deps: {
  store: SchedulePort;
  scheduler: Scheduler;
  keys: SigningKeyRegistry;
  now: () => Date;
}): EventIngestor {
  return {
    async ingest(event) {
      if (event.body.length > 16384) throw new ScheduleDenied('EVENT_TOO_LARGE');
      const trigger = await deps.store.trigger(event.triggerId);
      if (
        trigger === undefined ||
        trigger.source !== event.source ||
        trigger.signingKeyId !== event.keyId
      )
        throw new ScheduleDenied('TRIGGER_MISMATCH');
      const key = await deps.keys.get(event.keyId);
      if (key === undefined || key.algorithm !== trigger.algorithm)
        throw new ScheduleDenied('SIGNING_KEY_REJECTED');
      verifyEventSignature(event, key);
      const now = deps.now();
      validateReplayTime(event.timestamp, now, trigger.replayWindowSeconds);
      const payload = parsePayload(event.body, trigger.payloadSchema);
      if ((await deps.store.received(event.source, event.eventId)) !== undefined)
        throw new ScheduleDenied('EVENT_REPLAYED');
      const eventKey = sourceEventKey(event.source, event.eventId);
      const run = await deps.scheduler.fireEvent({
        key: eventKey,
        triggerId: trigger.id,
        scheduleId: trigger.scheduleId,
        source: event.source,
        eventId: event.eventId,
        timestamp: event.timestamp,
        receivedAt: now.toISOString(),
        digest: canonicalPayloadSha256({
          source: event.source,
          eventId: event.eventId,
          timestamp: event.timestamp,
          keyId: event.keyId,
          payload,
        }),
        trust: 'untrusted',
        payload,
        runId: scheduleRunId(trigger.scheduleId, event.timestamp, eventKey),
      });
      if (run === undefined) throw new ScheduleDenied('EVENT_REPLAYED');
      return run;
    },
  };
}

function validateReplayTime(value: string, now: Date, seconds: number): void {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value ||
    timestamp > now.getTime() ||
    now.getTime() - timestamp > seconds * 1000
  )
    throw new ScheduleDenied('REPLAY_WINDOW');
}
function parsePayload(
  body: Buffer,
  schema: Parameters<typeof validEventPayload>[0],
): Record<string, string | number | boolean> {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    throw new ScheduleDenied('INVALID_EVENT_PAYLOAD');
  }
  if (!validEventPayload(schema, payload)) throw new ScheduleDenied('INVALID_EVENT_PAYLOAD');
  return payload;
}
