import { expect, it } from 'vitest';

import { fixtureContext, fixtureOutput } from './fixtures.js';
import { citationVerifier, resultDigest } from './verifier.js';
const verifier = citationVerifier(
  new Map([['source-1', 'Grounded source text']]),
  'independent-v1',
);
it('accepts independently supported citations', async () => {
  expect(await verifier.verify(fixtureContext, fixtureOutput)).toEqual({
    accepted: true,
    verifierRef: 'independent-v1',
  });
});
it.each([
  { answer: 'unsupported', citedSourceIds: ['source-1'] },
  { answer: 'Grounded source text', citedSourceIds: ['hidden'] },
  { answer: 'Grounded source text', citedSourceIds: [] },
  { answer: 'Grounded source text', citedSourceIds: ['source-1', 'source-1'] },
])('rejects unsupported result %#', async (output) => {
  expect((await verifier.verify(fixtureContext, output)).accepted).toBe(false);
});
it('binds verification to answer and citations by digest', () => {
  expect(resultDigest(fixtureOutput)).not.toBe(
    resultDigest({ ...fixtureOutput, answer: 'changed' }),
  );
});

it('rejects a known source outside the computed child grant', async () => {
  const context = { ...fixtureContext, authority: { ...fixtureContext.authority, grants: [] } };
  expect((await verifier.verify(context, fixtureOutput)).accepted).toBe(false);
});
it('rejects extra unsupported text even alongside a valid citation', async () => {
  expect(
    (
      await verifier.verify(fixtureContext, {
        ...fixtureOutput,
        answer: fixtureOutput.answer + ' unsupported assertion',
      })
    ).accepted,
  ).toBe(false);
});
