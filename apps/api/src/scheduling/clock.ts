export type ScheduleClock = { now: () => Date };
export function createFakeScheduleClock(
  initial = '2026-10-14T10:00:00.000Z',
): ScheduleClock & { advance(ms: number): void; set(iso: string): void } {
  let at = Date.parse(initial);
  if (!Number.isFinite(at)) throw new RangeError('clock instant');
  return {
    now: () => new Date(at),
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('clock delta');
      at += ms;
    },
    set(iso) {
      const next = Date.parse(iso);
      if (!Number.isFinite(next)) throw new RangeError('clock instant');
      at = next;
    },
  };
}
