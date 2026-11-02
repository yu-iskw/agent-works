const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const dayOf = (iso: string): string => dayKey(new Date(iso));

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Today / Yesterday / a short date, for the separators between days. */
export function dayLabel(day: string, now: Date): string {
  if (day === dayKey(now)) return 'Today';
  if (day === dayKey(new Date(now.getTime() - DAY))) return 'Yesterday';
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Restrained relative time for list rows: a clock today, a weekday this week, else a date. */
export function listTime(iso: string, now: Date): string {
  const date = new Date(iso);
  const age = now.getTime() - date.getTime();
  if (age < MINUTE) return 'now';
  if (dayKey(date) === dayKey(now)) return clockTime(iso);
  if (age < 7 * DAY) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
