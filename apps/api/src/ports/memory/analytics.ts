import { createAnalyticsPort } from '../../analytics/store.js';

import type { AnalyticsDriver, AnalyticsPort, AnalyticsState } from '../analytics.js';
export function createMemoryAnalyticsPort(): AnalyticsPort {
  let state: AnalyticsState = { metrics: [], datasets: [], reports: [], audits: [] };
  const driver: AnalyticsDriver = {
    transaction<T>(operation: (s: AnalyticsState) => T): Promise<T> {
      return Promise.resolve().then(() => {
        const next = structuredClone(state);
        const result = operation(next);
        state = next;
        return structuredClone(result);
      });
    },
  };
  return createAnalyticsPort(driver);
}
