import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function compile(project: string): void {
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', project],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
}

beforeAll(() => {
  compile('packages/domain');
  compile('packages/policy');
  compile('packages/cli');
}, 120_000);

it('contract.cli.policy-explain', () => {
  const stdout = execFileSync(
    process.execPath,
    [
      resolve(root, 'packages/cli/dist/aw.js'),
      'policy',
      'explain',
      resolve(root, 'fixtures/policy/write-without-approval.json'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const golden = readFileSync(
    resolve(root, 'fixtures/policy/write-without-approval.golden.txt'),
    'utf8',
  );
  expect(stdout).toBe(golden);
});
