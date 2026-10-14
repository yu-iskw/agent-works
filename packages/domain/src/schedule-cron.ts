type CronField = { readonly values: ReadonlySet<number>; readonly wildcard: boolean };
export type ParsedCron = readonly CronField[];
const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;
export function parseCron(expression: string): ParsedCron {
  if (expression.length > 128) throw new RangeError('cron expression length');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new RangeError('five-field cron required');
  return parts.map((part, index) => parseField(part, ranges.at(index)!));
}
export function validCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}
function parseField(part: string, bounds: readonly [number, number]): CronField {
  const values = new Set<number>();
  for (const term of part.split(',')) {
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded 128-character cron; numeric spans use disjoint delimiters
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term);
    if (match === null) throw new RangeError('cron term');
    const { start, end, step } = termRange(match, bounds);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, wildcard: part.startsWith('*') };
}
export function cronMatches(cron: ParsedCron, parts: readonly number[]): boolean {
  const matches = cron.map((field, index) => field.values.has(parts.at(index)!));
  const day =
    cron[2].wildcard || cron[4].wildcard ? matches[2] && matches[4] : matches[2] || matches[4];
  return matches[0] && matches[1] && matches[3] && day;
}

function termRange(
  match: RegExpExecArray,
  bounds: readonly [number, number],
): { start: number; end: number; step: number } {
  const [low, high] = bounds;
  const stepText = match.at(2);
  const term = match[1];
  const step = stepText === undefined ? 1 : Number(stepText);
  const span = term === '*' ? [low, high] : term.split('-').map(Number);
  const start = span[0];
  const end = span.at(1) ?? (stepText === undefined ? start : high);
  if (start < low || end > high || start > end || step < 1 || step > high - low + 1)
    throw new RangeError('cron bounds');
  return { start, end, step };
}
