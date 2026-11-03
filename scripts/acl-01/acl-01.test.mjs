import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

// The spike suites use node:test; this bridge runs them under the existing Vitest gate.
it('runs the ACL-01 harness and aggregator suites', () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      'spikes/retrieval/compare/aggregate.test.mjs',
      'spikes/retrieval/compare/local-harness.test.mjs',
    ],
    { cwd: repository, encoding: 'utf8', timeout: 60_000 },
  );
  expect(output).toContain('# fail 0');
}, 65_000);
