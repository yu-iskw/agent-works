import { expect, test, vi } from 'vitest';

import { createScheduleWorker } from './worker.js';

import type { Scheduler } from './service.js';
test('worker starts idempotently, reports failures, and stops promptly', async () => {
  const tick = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('temporary'))
    .mockResolvedValue(undefined);
  const error = vi.fn();
  const scheduler = { tick } as unknown as Scheduler;
  const worker = createScheduleWorker(scheduler, error, 5);
  worker.start();
  worker.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await worker.stop();
  const calls = tick.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(tick).toHaveBeenCalledTimes(calls);
  expect(error).toHaveBeenCalledTimes(1);
  expect(calls).toBeGreaterThan(1);
});
test('worker stop waits for its pending fire before database shutdown', async () => {
  let release: () => void = () => {};
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const worker = createScheduleWorker({ tick } as unknown as Scheduler, vi.fn());
  worker.start();
  const stop = worker.stop();
  let stopped = false;
  void stop.then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stop;
  expect(stopped).toBe(true);
});
