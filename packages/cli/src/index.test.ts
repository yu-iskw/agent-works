import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { run } from './index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function explain(file: string): { code: number; stdout: string } {
  const chunks: string[] = [];
  const code = run(['node', 'aw', 'policy', 'explain', resolve(root, file)], {
    write(chunk: string) {
      chunks.push(chunk);
    },
  });
  return { code, stdout: chunks.join('') };
}

describe('aw policy explain', () => {
  it('prints the golden deny for a write without approval', () => {
    const golden = readFileSync(
      resolve(root, 'fixtures/policy/write-without-approval.golden.txt'),
      'utf8',
    );
    expect(explain('fixtures/policy/write-without-approval.json')).toEqual({
      code: 0,
      stdout: golden,
    });
  });

  it('denies when the fact source is down', () => {
    const golden = readFileSync(
      resolve(root, 'fixtures/policy/fact-source-down.golden.txt'),
      'utf8',
    );
    expect(explain('fixtures/policy/fact-source-down.json')).toEqual({ code: 0, stdout: golden });
  });

  it('ignores model text that claims approval', () => {
    const golden = readFileSync(
      resolve(root, 'fixtures/policy/write-without-approval.golden.txt'),
      'utf8',
    );
    expect(explain('fixtures/policy/model-claims-approval.json')).toEqual({
      code: 0,
      stdout: golden,
    });
  });

  it('returns 1 for a fixture that is not an object', () => {
    expect(explain('fixtures/policy/write-without-approval.golden.txt').code).toBe(1);
  });
});
