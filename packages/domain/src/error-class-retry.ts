import { classifyError, ClassifiedError } from './error-class.js';

export type RetryConfig = {
  readonly approval: 'PLACEHOLDER';
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly deadlineMs: number;
  readonly minAttemptMs: number;
};
export type RetryClock = { now(): number; sleep(ms: number): Promise<void>; random(): number };
export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | {
      readonly retry: false;
      readonly reason: 'classification' | 'attempts' | 'deadline' | 'storm';
    };

/** Shared by opted-in invocations: a finite retry pool, never replenished implicitly. */
export class RetryStormBudget {
  private used = 0;
  constructor(readonly cap: number) {
    if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError('retry cap');
  }
  take(): boolean {
    if (this.used >= this.cap) return false;
    this.used += 1;
    return true;
  }
  consumed(): number {
    return this.used;
  }
}

export function validateRetryConfig(config: RetryConfig): void {
  for (const value of [
    config.maxAttempts,
    config.baseDelayMs,
    config.maxDelayMs,
    config.deadlineMs,
    config.minAttemptMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('retry config');
  }
  if (config.maxAttempts < 1 || config.baseDelayMs > config.maxDelayMs)
    throw new RangeError('retry config');
}

export function retryDecision(input: {
  error: unknown;
  attempt: number;
  config: RetryConfig;
  nowMs: number;
  jitter: number;
  storm: RetryStormBudget;
}): RetryDecision {
  const { error, attempt, config, nowMs, jitter, storm } = input;
  validateRetryConfig(config);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('attempt');
  if (!Number.isFinite(nowMs) || !Number.isFinite(jitter) || jitter < 0 || jitter >= 1)
    throw new RangeError('clock or jitter');
  if (classifyError(error) !== 'transient') return { retry: false, reason: 'classification' };
  if (attempt >= config.maxAttempts) return { retry: false, reason: 'attempts' };
  const ceiling = Math.min(config.maxDelayMs, config.baseDelayMs * 2 ** Math.min(attempt - 1, 52));
  const delayMs = Math.floor(ceiling * jitter);
  if (nowMs + delayMs + config.minAttemptMs >= config.deadlineMs)
    return { retry: false, reason: 'deadline' };
  if (!storm.take()) return { retry: false, reason: 'storm' };
  return { retry: true, delayMs };
}

export async function withRetry<T>(input: {
  config: RetryConfig;
  clock: RetryClock;
  storm: RetryStormBudget;
  run(attempt: number): Promise<T>;
  onRetry?(attempt: number, delayMs: number): Promise<void>;
}): Promise<T> {
  validateRetryConfig(input.config);
  for (let attempt = 1; ; attempt += 1) {
    if (input.clock.now() + input.config.minAttemptMs >= input.config.deadlineMs)
      throw new ClassifiedError('permanent', 'deadline');
    try {
      return await input.run(attempt);
    } catch (error) {
      const decision = retryDecision({
        error,
        attempt,
        config: input.config,
        nowMs: input.clock.now(),
        jitter: input.clock.random(),
        storm: input.storm,
      });
      if (!decision.retry) throw error;
      await input.onRetry?.(attempt, decision.delayMs);
      await input.clock.sleep(decision.delayMs);
    }
  }
}
