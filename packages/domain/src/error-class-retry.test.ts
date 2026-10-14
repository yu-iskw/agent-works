import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { RetryStormBudget, retryDecision, withRetry } from './error-class-retry.js';
import { ClassifiedError } from './error-class.js';

import type { RetryClock, RetryConfig } from './error-class-retry.js';

const config: RetryConfig = {
  approval: 'PLACEHOLDER',
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 400,
  deadlineMs: 10_000,
  minAttemptMs: 10,
};
function fakeClock(): RetryClock & { delays: number[] } {
  let time = 0;
  const delays: number[] = [];
  return {
    delays,
    now: () => time,
    random: () => 0.5,
    sleep(ms) {
      delays.push(ms);
      time += ms;
      return Promise.resolve();
    },
  };
}
describe('deadline-aware shared retry budget', () => {
  it.each(['policy', 'permanent'] as const)('never retries %s errors', async (kind) => {
    const clock = fakeClock();
    const run = vi.fn().mockRejectedValue(new ClassifiedError(kind, 'forbidden'));
    await expect(
      withRetry({ run, clock, config, storm: new RetryStormBudget(10) }),
    ).rejects.toBeInstanceOf(ClassifiedError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(clock.delays).toEqual([]);
  });
  it('retries transient failures within attempts and deadline', async () => {
    const clock = fakeClock();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new ClassifiedError('transient', 'unavailable'))
      .mockResolvedValue('done');
    await expect(withRetry({ run, clock, config, storm: new RetryStormBudget(10) })).resolves.toBe(
      'done',
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([50]);
  });
  it('caps a retry storm across arbitrary clients, attempts, classes and jitter (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.array(
          fc.record({
            attempt: fc.integer({ min: 1, max: 20 }),
            jitter: fc.integer({ min: 0, max: 999 }),
            kind: fc.constantFrom('transient', 'permanent', 'policy'),
          }),
          { maxLength: 600 },
        ),
        (cap, failures) => {
          const storm = new RetryStormBudget(cap);
          let permitted = 0;
          for (const failure of failures) {
            const result = retryDecision({
              error: new ClassifiedError(failure.kind, 'unavailable'),
              attempt: failure.attempt,
              config,
              nowMs: 0,
              jitter: failure.jitter / 1000,
              storm,
            });
            if (result.retry) {
              permitted += 1;
              expect(result.delayMs).toBeLessThanOrEqual(config.maxDelayMs);
              expect(failure.kind).toBe('transient');
            }
          }
          expect(permitted).toBeLessThanOrEqual(cap);
          expect(storm.consumed()).toBe(permitted);
        },
      ),
      { seed: 135, numRuns: 500 },
    );
  });
  it('refuses a retry when backoff would consume the remaining deadline', () => {
    expect(
      retryDecision({
        error: new ClassifiedError('transient', 'unavailable'),
        attempt: 1,
        config,
        nowMs: 9990,
        jitter: 0.5,
        storm: new RetryStormBudget(10),
      }),
    ).toEqual({ retry: false, reason: 'deadline' });
  });
  it('never begins another attempt after the sleep exhausts its deadline', async () => {
    let now = 0;
    const run = vi.fn().mockRejectedValue(new ClassifiedError('transient', 'unavailable'));
    const clock = {
      now: () => now,
      random: () => 0.5,
      sleep() {
        now = 10_000;
        return Promise.resolve();
      },
    };
    await expect(
      withRetry({ run, clock, config, storm: new RetryStormBudget(10) }),
    ).rejects.toMatchObject({ code: 'deadline' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('does not replenish the pool between callers', async () => {
    const storm = new RetryStormBudget(2);
    const run = vi.fn().mockRejectedValue(new ClassifiedError('transient', 'rate_limited'));
    for (let index = 0; index < 10; index += 1)
      await expect(withRetry({ run, config, clock: fakeClock(), storm })).rejects.toBeInstanceOf(
        ClassifiedError,
      );
    expect(run).toHaveBeenCalledTimes(12);
    expect(storm.consumed()).toBe(2);
  });
  it('rejects invalid limits and randomness', () => {
    expect(() => new RetryStormBudget(-1)).toThrow(RangeError);
    expect(() =>
      retryDecision({
        error: null,
        attempt: 1,
        config,
        nowMs: 0,
        jitter: 1,
        storm: new RetryStormBudget(1),
      }),
    ).toThrow(RangeError);
  });
});
