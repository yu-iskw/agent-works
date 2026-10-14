import { run as baseRun } from './run.js';
import { runSchedule } from './schedule.js';
type Output = { write(data: string): void };
export function run(
  argv: readonly [string, string, 'schedule', ...string[]],
  stdout: Output,
): Promise<number>;
export function run(argv: readonly string[], stdout: Output): number;
export function run(argv: readonly string[], stdout: Output): number | Promise<number> {
  return argv[2] === 'schedule'
    ? runSchedule(argv, stdout, { assertion: process.env.AW_IAP_ASSERTION })
    : baseRun(argv, stdout);
}
