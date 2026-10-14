import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { loadDataset } from './dataset.mjs';
import { scoreCase, scoreDataset } from './scorer.mjs';

const known = ['grounding', 'tools', 'leaks', 'workflow'].flatMap((group) =>
  JSON.parse(
    readFileSync(
      new URL(`../../evals/results/fixtures/known-${group}.json`, import.meta.url),
      'utf8',
    ),
  ),
);

describe('independent known-answer scorer fixtures', () => {
  test.each(known)('$name', ({ case: row, observation, known: answer }) => {
    const result = scoreCase(row, observation);
    for (const [name, expected] of Object.entries(answer)) {
      if (Array.isArray(expected))
        expect(result.metrics[name]).toEqual({
          numerator: expected[0],
          denominator: expected[1],
          value: expected[1] === 0 ? null : expected[0] / expected[1],
        });
      else expect(result.security[name]).toBe(expected);
    }
  });
});

test('micro-average uses counts rather than mean case scores', () => {
  const left = known[0];
  const right = structuredClone(known[1]);
  right.case.id = 'dev-independent';
  right.observation.caseId = right.case.id;
  const result = scoreDataset([left.case, right.case], [left.observation, right.observation]);
  expect(result.metrics.citationPrecision).toEqual({ numerator: 2, denominator: 3, value: 2 / 3 });
  expect(result.byAclGroup.operations.citationPrecision.value).toBe(2 / 3);
});

test('reordered argument object keys have identical meaning', () => {
  const fixture = structuredClone(known[0]);
  fixture.case.expected.trajectory[0].arguments = { a: 1, b: { x: 2, y: 3 } };
  fixture.observation.calls[0].arguments = { b: { y: 3, x: 2 }, a: 1 };
  expect(scoreCase(fixture.case, fixture.observation).metrics.toolCallCorrectness.value).toBe(1);
});

test('arrays in arguments preserve order', () => {
  const fixture = structuredClone(known[0]);
  fixture.case.expected.trajectory[0].arguments = { recipients: ['alice', 'bob'] };
  fixture.observation.calls[0].arguments = { recipients: ['bob', 'alice'] };
  expect(scoreCase(fixture.case, fixture.observation).metrics.toolCallCorrectness.value).toBe(0);
});

test.each(['denied', 'error', 'executed'])(
  'probe dispatch evidence counts once regardless of the %s broker outcome',
  (outcome) => {
    const fixture = structuredClone(known.find((row) => row.name === 'correct-abstention'));
    fixture.observation.calls = [
      { tool: 'ticket.create', arguments: {}, authorized: false, outcome },
    ];
    fixture.observation.diagnostics = ['SECURITY_SIDE_EFFECT_DISPATCHED'];
    expect(scoreCase(fixture.case, fixture.observation).security.unauthorizedExecutions).toBe(1);
  },
);

test.each(['answer', 'diagnostics', 'calls', 'citations', 'retrievedSourceIds'])(
  'all externally observable surfaces are considered for leaks: %s',
  (surface) => {
    const fixture = structuredClone(known.find((row) => row.name === 'correct-abstention'));
    const marker = fixture.case.expected.forbiddenMarkers[0];
    if (surface === 'answer') fixture.observation.answer = marker;
    else if (surface === 'calls')
      fixture.observation.calls = [
        { tool: 'email.send', arguments: { body: marker }, authorized: false, outcome: 'denied' },
      ];
    else fixture.observation[surface] = [marker];
    expect(scoreCase(fixture.case, fixture.observation).security.leaks).toBe(1);
  },
);

test.each(['percent', 'html', 'nfkc', 'base64', 'malformed'])(
  'leak normalization handles %s transport',
  (format) => {
    const fixture = structuredClone(known.find((row) => row.name === 'correct-abstention'));
    const marker = fixture.case.expected.forbiddenMarkers[0];
    const forms = {
      percent: encodeURIComponent(marker),
      html: [...marker].map((char) => `&#${char.codePointAt(0)};`).join(''),
      nfkc: marker.replaceAll('P', 'Ｐ'),
      base64: Buffer.from(marker).toString('base64'),
      malformed: `%XX${marker}`,
    };
    fixture.observation.diagnostics = [forms[format]];
    expect(scoreCase(fixture.case, fixture.observation).security.leaks).toBe(1);
  },
);

test('marker matches across surfaces count once per protected marker', () => {
  const fixture = structuredClone(known.find((row) => row.name === 'plain-answer-leak'));
  fixture.observation.diagnostics = [fixture.observation.answer, fixture.observation.answer];
  expect(scoreCase(fixture.case, fixture.observation).security.leaks).toBe(1);
});

test('missing or extra evidence is a hard input error', () => {
  const row = known[0];
  expect(() => scoreDataset([], [])).toThrow('empty');
  expect(() => scoreDataset([row.case], [])).toThrow('missing');
  expect(() => scoreDataset([row.case], [row.observation, row.observation])).toThrow(
    'duplicate observation',
  );
  expect(() => scoreDataset([row.case, row.case], [row.observation])).toThrow('duplicate case');
  expect(() => scoreCase(row.case, { ...row.observation, caseId: 'other' })).toThrow('mismatch');
  expect(() =>
    scoreDataset([row.case], [row.observation, { ...row.observation, caseId: 'other' }]),
  ).toThrow('unknown observation');
});

test('every published metric has a known-answer fixture', () => {
  const metricNames = Object.keys(scoreCase(known[0].case, known[0].observation).metrics);
  for (const name of metricNames)
    expect(
      known.filter((fixture) => Object.hasOwn(fixture.known, name)).length,
    ).toBeGreaterThanOrEqual(2);
  expect(loadDataset().cases.length).toBe(102);
});
