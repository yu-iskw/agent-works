import { headerValue } from '../http.js';
import { ScheduleConflict } from '../ports/schedule-port.js';
import { ScheduleDenied } from '../scheduling/authority.js';

import type { Route } from '../http.js';
import type { EventIngestor } from '../scheduling/ingestion.js';
export function eventsIngestRoutes(ingestor: EventIngestor): Record<string, Route> {
  return {
    'POST /v1/events/ingest': async (request) => {
      const headers = [
        'x-aw-trigger-id',
        'x-aw-event-source',
        'x-aw-event-id',
        'x-aw-event-time',
        'x-aw-key-id',
        'x-aw-signature',
      ].map((key) => headerValue(request.headers, key));
      if (headers.some((v) => v === undefined || v.length === 0))
        return { status: 401, body: { error: 'signature_required' } };
      const [triggerId, source, eventId, timestamp, keyId, signature] = headers as string[];
      try {
        return {
          status: 202,
          body: await ingestor.ingest({
            triggerId,
            source,
            eventId,
            timestamp,
            keyId,
            signature,
            body: request.body,
          }),
        };
      } catch (error) {
        if (error instanceof ScheduleConflict)
          return { status: 409, body: { error: 'event_replayed' } };
        if (error instanceof ScheduleDenied)
          return {
            status: error.code === 'EVENT_REPLAYED' ? 409 : 422,
            body: { error: error.code },
          };
        return { status: 503, body: { error: 'event_ingestion_unavailable' } };
      }
    },
  };
}
