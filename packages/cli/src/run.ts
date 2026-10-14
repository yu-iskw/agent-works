import { readFileSync } from 'node:fs';

import { runAdmin } from './admin.js';
import { explainFixture } from './explain.js';

type Stdout = {
  write(data: string): void;
};

export function run(
  argv: readonly [string, string, 'admin', ...string[]],
  stdout: Stdout,
): Promise<number>;
export function run(argv: readonly string[], stdout: Stdout): number;
export function run(argv: readonly string[], stdout: Stdout): number | Promise<number> {
  if (argv[2] === 'admin') {
    return runAdmin(argv, stdout, { assertion: process.env.AW_IAP_ASSERTION });
  }
  if (argv.length !== 5) return 1;
  const command = argv[2];
  const sub = argv[3];
  const file = argv[4];
  if (command !== 'policy' || sub !== 'explain') return 1;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    stdout.write(explainFixture(parsed));
    return 0;
  } catch {
    return 1;
  }
}
