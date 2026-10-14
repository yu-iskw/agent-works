import { setTimeout as delay } from 'node:timers/promises';

import type { Scheduler } from './service.js';
export function createScheduleWorker(
  scheduler: Scheduler,
  onError: () => void,
  intervalMs = 1000,
): { start(): void; stop(): Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('worker interval');
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await scheduler.tick();
      } catch {
        onError();
      }
      try {
        await delay(intervalMs, undefined, { signal });
      } catch {
        if (!isStopped(signal)) onError();
      }
    }
  }
  return {
    start() {
      if (pending !== undefined) return;
      controller = new AbortController();
      pending = loop(controller.signal);
    },
    async stop() {
      controller?.abort();
      await pending;
      pending = undefined;
      controller = undefined;
    },
  };
}

function isStopped(signal: AbortSignal): boolean {
  return signal.aborted;
}
