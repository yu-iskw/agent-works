import { cronMatches, parseCron } from '../../../../packages/domain/dist/schedule-cron.js';

import type { ScheduleSpec } from '../../../../packages/domain/dist/schedule.js';
type LocalTime = { minute: number; hour: number; day: number; month: number; weekday: number };
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function localTime(at: Date, timezone: string): LocalTime {
  const parts = formatter(timezone).formatToParts(at);
  const fields = new Map(parts.map((v) => [v.type, v.value]));
  return {
    minute: Number(fields.get('minute')),
    hour: Number(fields.get('hour')),
    day: Number(fields.get('day')),
    month: Number(fields.get('month')),
    weekday: weekdays.indexOf(fields.get('weekday') ?? ''),
  };
}
export function inAllowedWindow(spec: ScheduleSpec, at: Date): boolean {
  const parts = localTime(at, spec.timezone);
  const minute = parts.hour * 60 + parts.minute;
  const [sh, sm] = spec.allowedWindow.start.split(':').map(Number);
  const [eh, em] = spec.allowedWindow.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const days = spec.allowedWindow.weekdays;
  if (start === end) return days.includes(parts.weekday);
  if (start < end) return days.includes(parts.weekday) && minute >= start && minute < end;
  return (
    (minute >= start && days.includes(parts.weekday)) ||
    (minute < end && days.includes((parts.weekday + 6) % 7))
  );
}
/** Select at most the most recent missed slot. No unbounded outage backlog. */
export function dueSlot(spec: ScheduleSpec, cursor: string, now: Date): string | undefined {
  if (now.getTime() >= Date.parse(spec.expiresAt) || now.getTime() <= Date.parse(cursor))
    return undefined;
  const slot =
    spec.timing.kind === 'interval' ? intervalSlot(spec, now) : cronSlot(spec, now, cursor);
  if (
    slot === undefined ||
    slot <= Date.parse(cursor) ||
    !inAllowedWindow(spec, new Date(slot)) ||
    !inAllowedWindow(spec, now)
  )
    return undefined;
  if (spec.misfire === 'skip' && now.getTime() - slot >= 60000) return undefined;
  return new Date(slot).toISOString();
}
function intervalSlot(spec: ScheduleSpec, now: Date): number | undefined {
  if (spec.timing.kind !== 'interval') return undefined;
  const anchor = Date.parse(spec.timing.anchor);
  const elapsed = now.getTime() - anchor;
  if (elapsed < 0) return undefined;
  return (
    anchor +
    Math.floor(elapsed / (spec.timing.everySeconds * 1000)) * spec.timing.everySeconds * 1000
  );
}
function cronSlot(spec: ScheduleSpec, now: Date, cursor: string): number | undefined {
  if (spec.timing.kind !== 'cron') return undefined;
  const cron = parseCron(spec.timing.expression);
  let at = Math.floor(now.getTime() / 60000) * 60000;
  // Bounded one-year scan; older outages are intentionally skipped.
  const floor = Math.max(Date.parse(cursor), at - 366 * 86400000);
  while (at > floor) {
    const p = localTime(new Date(at), spec.timezone);
    if (cronMatches(cron, [p.minute, p.hour, p.day, p.month, p.weekday])) return at;
    at -= 60000;
  }
  return undefined;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  const prior = formatters.get(timezone);
  if (prior !== undefined) return prior;
  const value = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  if (formatters.size >= 64) formatters.clear();
  formatters.set(timezone, value);
  return value;
}
