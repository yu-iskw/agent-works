import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

// Character codes so this source file does not contain the banned organization token.
const bannedToken = String.fromCharCode(117, 98, 105, 101);

const git = (args) => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return result;
};

test('tracked repository text does not contain the banned organization token', () => {
  const content = git(['grep', '-l', '-i', '-I', bannedToken]);
  expect(content.status, content.stdout).toBe(1);
  expect(content.stdout).toBe('');

  const names = git(['ls-files', '-z']);
  expect(names.status).toBe(0);
  const hits = names.stdout.split('\0').filter((path) => path.toLowerCase().includes(bannedToken));
  expect(hits).toEqual([]);
});
