import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { canonicalClient } from '../scripts/client-source.mjs';
import { buildClient } from '../scripts/client.mjs';
import { buildSpec } from '../scripts/spec.mjs';
it('generated client stays under 1500 lines and regenerates from operation schemas', () => {
  const source = readFileSync(new URL('../src/client.generated.ts', import.meta.url), 'utf8');
  expect(source.split('\n').length).toBeLessThanOrEqual(1500);
  const generated = buildClient(buildSpec());
  expect(generated).toContain('readTask(');
  expect(generated).toContain('decideApproval(');
  expect(() =>
    execFileSync(
      process.execPath,
      [new URL('../scripts/generate.mjs', import.meta.url).pathname, '--check'],
      { stdio: 'pipe' },
    ),
  ).not.toThrow();
});

it('compares formatted syntax while retaining meaningful string contents', () => {
  expect(canonicalClient('type X={readonly "id":string};')).toBe(
    canonicalClient('type X = { readonly id: string; };'),
  );
  expect(canonicalClient('const x="a b";')).not.toBe(canonicalClient('const x="ab";'));
  expect(canonicalClient('type X=string;')).not.toBe(canonicalClient('type X=number;'));
});
