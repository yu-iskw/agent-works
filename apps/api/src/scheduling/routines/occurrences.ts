import { cronMatches, parseCron } from '@agent-works/domain';

import { localTime } from '../time.js';

import type { ScheduleSpec } from '@agent-works/domain';

const MINUTE = 60_000;
/** Hard ceiling on a routine's lifetime, so the deterministic cron scan below stays bounded. */
export const MAX_ROUTINE_LIFETIME_SECONDS = 31 * 86_400;

/**
 * Every fire instant in [from, to), at most `limit` of them. The cron scan walks real UTC
 * minutes and asks the timezone for the local time, so a DST repeat yields two fires and a
 * DST gap yields none. The allowed window is ignored: it can only remove fires.
 */
export function occurrences(spec: ScheduleSpec, from: number, to: number, limit: number): number[] {
  const out: number[] = [];
  if (spec.timing.kind === 'interval') {
    const step = spec.timing.everySeconds * 1000;
    const anchor = Date.parse(spec.timing.anchor);
    let at = from <= anchor ? anchor : anchor + Math.ceil((from - anchor) / step) * step;
    for (; at < to && out.length < limit; at += step) out.push(at);
    return out;
  }
  const cron = parseCron(spec.timing.expression);
  for (let at = Math.ceil(from / MINUTE) * MINUTE; at < to && out.length < limit; at += MINUTE) {
    const p = localTime(new Date(at), spec.timezone);
    if (cronMatches(cron, [p.minute, p.hour, p.day, p.month, p.weekday])) out.push(at);
  }
  return out;
}

/** Smallest gap in seconds between consecutive fires, or undefined when fewer than two. */
export function minGapSeconds(fires: readonly number[]): number | undefined {
  let min: number | undefined;
  fires.forEach((at, i) => {
    if (i === 0) return;
    const gap = (at - fires[i - 1]) / 1000;
    if (min === undefined || gap < min) min = gap;
  });
  return min;
}
