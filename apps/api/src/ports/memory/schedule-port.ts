import { createSchedulePort } from '../../scheduling/store.js';

import type { ScheduleDriver, SchedulePort, ScheduleState } from '../schedule-port.js';
function createMemoryScheduleDriver(): ScheduleDriver {
  let state: ScheduleState = { schedules: [], triggers: [], runs: [], events: [], audit: [] };
  return {
    transaction<T>(operation: (s: ScheduleState) => T): Promise<T> {
      return Promise.resolve().then(() => {
        const next = structuredClone(state);
        const result = operation(next);
        state = next;
        return structuredClone(result);
      });
    },
  };
}
export function createMemorySchedulePort(
  driver: ScheduleDriver = createMemoryScheduleDriver(),
): SchedulePort {
  return createSchedulePort(driver);
}
