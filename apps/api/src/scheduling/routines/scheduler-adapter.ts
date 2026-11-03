import { ScheduleConflict } from '../../ports/schedule-port.js';

import type { SchedulePort } from '../../ports/schedule-port.js';
import type { Scheduler } from '../service.js';
import type { RoutineSchedules } from './service.js';

type ConsentSink = {
  grant(value: { ref: string; subject: string; digest: string; expiresAt: string }): void;
};

/**
 * Binds the routine service to the existing scheduler. The grant check already ran, so the grant
 * is recorded as the consent for this exact schedule digest; a different spec gets no consent.
 */
export function createRoutineSchedules(deps: {
  readonly scheduler: Pick<Scheduler, 'create' | 'change'>;
  readonly store: Pick<SchedulePort, 'read'>;
  readonly consent: ConsentSink;
}): RoutineSchedules {
  return {
    async create(spec, sponsor, consent) {
      deps.consent.grant({ ...consent, subject: sponsor });
      await deps.scheduler.create(spec, sponsor);
    },
    async revoke(sponsor, scheduleId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const row = await deps.store.read(sponsor, scheduleId);
        if (row === undefined || row.state === 'revoked') return;
        try {
          await deps.scheduler.change(sponsor, scheduleId, row.revision, 'revoke');
          return;
        } catch (error) {
          if (!(error instanceof ScheduleConflict)) throw error;
        }
      }
    },
  };
}
