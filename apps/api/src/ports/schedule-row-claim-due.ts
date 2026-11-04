import { cronMatches, parseCron } from '@agent-works/domain';

import { localTime } from '../scheduling/time.js';

import type { ScheduleSpec } from '@agent-works/domain';

const MINUTE = 60000;
const CRON_WAKE_HORIZON_MINUTES = 1440;

/**
 * Earliest instant strictly after `after` at which the schedule may have a slot, or a bounded
 * wake-up when a cron has none within a day. Null when nothing can fire before expiry.
 * It is a wake hint only: the claim recomputes the slot with dueSlot under the row lock.
 */
export function nextDueAfter(spec: ScheduleSpec, after: string): string | null {
  const from = Date.parse(after);
  const expiry = Date.parse(spec.expiresAt);
  const candidate =
    spec.timing.kind === 'interval' ? intervalNext(spec.timing, from) : cronNext(spec, from);
  return candidate >= expiry ? null : new Date(candidate).toISOString();
}

function intervalNext(timing: { everySeconds: number; anchor: string }, from: number): number {
  const anchor = Date.parse(timing.anchor);
  if (from < anchor) return anchor;
  const step = timing.everySeconds * 1000;
  return anchor + (Math.floor((from - anchor) / step) + 1) * step;
}

function cronNext(spec: ScheduleSpec, from: number): number {
  if (spec.timing.kind !== 'cron') throw new Error('cron timing required');
  const cron = parseCron(spec.timing.expression);
  const start = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < CRON_WAKE_HORIZON_MINUTES; i += 1) {
    const at = start + i * MINUTE;
    const p = localTime(new Date(at), spec.timezone);
    if (cronMatches(cron, [p.minute, p.hour, p.day, p.month, p.weekday])) return at;
  }
  return start + CRON_WAKE_HORIZON_MINUTES * MINUTE;
}
