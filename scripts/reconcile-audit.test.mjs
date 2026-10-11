import { expect, test } from 'vitest';

import { spansFromOtlp, tracePropagated } from './reconcile-audit.mjs';

const traceId = '00112233445546778899aabbccddeeff';

test('shared trace id across web api runner and retrieval', () => {
  const spans = spansFromOtlp(
    [
      spanLine('web', traceId, 'aabbccddeeff0011', ''),
      spanLine('api', traceId, '2233445566778899', 'aabbccddeeff0011'),
      spanLine('runner', traceId, '0011223344556677', '2233445566778899'),
      spanLine('retrieval', traceId, '8899aabbccddeeff', '2233445566778899'),
    ].join('\n'),
  );
  if (spans === undefined) throw new Error('unreadable spans');
  expect(tracePropagated(spans)).toBe(true);
  expect(spans.map((span) => span.traceId)).toEqual([traceId, traceId, traceId, traceId]);
});

test('each trace id is checked on its own', () => {
  const other = 'ffeeddccbbaa99887766554433221100';
  const spans = spansFromOtlp(
    [
      spanLine('web', traceId, 'aabbccddeeff0011', ''),
      spanLine('api', traceId, '2233445566778899', 'aabbccddeeff0011'),
      spanLine('runner', traceId, '0011223344556677', '2233445566778899'),
      spanLine('retrieval', traceId, '8899aabbccddeeff', '2233445566778899'),
      spanLine('web', other, '1111111111111111', ''),
      spanLine('api', other, '2222222222222222', '1111111111111111'),
      spanLine('runner', other, '3333333333333333', '2222222222222222'),
      spanLine('retrieval', other, '4444444444444444', '2222222222222222'),
    ].join('\n'),
  );
  expect(tracePropagated(spans)).toBe(true);
});

function spanLine(name, traceIdValue, spanId, parentSpanId) {
  return JSON.stringify({
    resourceSpans: [
      { scopeSpans: [{ spans: [{ name, traceId: traceIdValue, spanId, parentSpanId }] }] },
    ],
  });
}
