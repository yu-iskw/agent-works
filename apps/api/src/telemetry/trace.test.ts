import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { continuePropagated, toOtlpJsonLines } from './trace.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const requestId = '00112233-4455-4677-8899-aabbccddeeff';
const traceId = '00112233445546778899aabbccddeeff';
const webSpanId = 'aabbccddeeff0011';
const childEntropy = '223344556677889900112233445566778899aabbccddeeff';

const propagated = [
  {
    name: 'web',
    traceId,
    spanId: webSpanId,
    parentSpanId: null,
  },
  {
    name: 'api',
    traceId,
    spanId: '2233445566778899',
    parentSpanId: webSpanId,
  },
  {
    name: 'runner',
    traceId,
    spanId: '0011223344556677',
    parentSpanId: '2233445566778899',
  },
  {
    name: 'retrieval',
    traceId,
    spanId: '8899aabbccddeeff',
    parentSpanId: '2233445566778899',
  },
] as const;

function webHeader(): string {
  const source = [
    "import { webTraceparent } from './apps/web/src/telemetry.ts';",
    `const header = webTraceparent(${JSON.stringify(requestId)}, ${JSON.stringify(webSpanId)});`,
    'if (header === undefined) process.exit(2);',
    'process.stdout.write(header);',
  ].join('\n');
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', source],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

it('audit.trace-propagated', () => {
  const header = webHeader();
  expect(header).toBe(`00-${traceId}-${webSpanId}-01`);
  const spans = continuePropagated(header, childEntropy);
  expect(spans).toEqual(propagated);
  if (spans === undefined) throw new Error('missing spans');
  const reconciled = spawnSync(process.execPath, ['scripts/reconcile-audit.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: toOtlpJsonLines(spans),
  });
  expect(reconciled.status).toBe(0);
  expect(reconciled.stdout).toBe('trace propagated\n');
});

it('rejects a trace that splits across ids', () => {
  const broken = propagated.map((span, index) =>
    index === 3 ? { ...span, traceId: 'ff'.repeat(16) } : span,
  );
  const reconciled = spawnSync(process.execPath, ['scripts/reconcile-audit.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: toOtlpJsonLines(broken),
  });
  expect(reconciled.status).toBe(1);
  expect(reconciled.stdout).toBe('');
});
