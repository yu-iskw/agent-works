import { withRetry } from '#domain-error-class-retry';

import type { RetryClock, RetryConfig, RetryStormBudget } from '#domain-error-class-retry';

/** Opt-in adapter seam: budget is shared per outage domain, never per attempt. */
export function retryAdapter<T>(
  run: (attempt: number) => Promise<T>,
  options: {
    config: RetryConfig;
    clock: RetryClock;
    storm: RetryStormBudget;
    onRetry?(attempt: number, delayMs: number): Promise<void>;
  },
): Promise<T> {
  return withRetry({ run, ...options });
}
