import { readFileSync } from 'node:fs';

import { explainFixture } from './explain.js';

type Stdout = {
  write(data: string): void;
};

export function run(argv: readonly string[], stdout: Stdout): number {
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
