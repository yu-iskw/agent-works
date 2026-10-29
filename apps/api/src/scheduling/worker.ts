import { setTimeout as delay } from 'node:timers/promises';

/** Polls `tick` until stopped; a second start is a no-op and stop waits for the running tick. */
export function createScheduleWorker(
  scheduler: { tick(): Promise<void> },
  onError: (error: unknown) => void,
  intervalMs = 1000,
): { start(): void; stop(): Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('worker interval');
  let pending: Promise<void> | undefined;
  let controller: AbortController | undefined;
  async function loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await scheduler.tick();
      } catch (error) {
        onError(error);
      }
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        if (!isStopped(signal)) onError(error);
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
