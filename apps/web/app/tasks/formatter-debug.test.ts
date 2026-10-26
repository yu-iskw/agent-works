import { execFileSync } from 'node:child_process';

import { test } from 'vitest';

test('temporary formatter diagnostic', () => {
  const formatted = execFileSync(
    'pnpm',
    ['exec', 'prettier', 'apps/web/app/tasks/handler.test.ts'],
    { encoding: 'utf8' },
  );
  process.stdout.write(`===PRETTIER OUTPUT START===\n${formatted}\n===PRETTIER OUTPUT END===\n`);
});
