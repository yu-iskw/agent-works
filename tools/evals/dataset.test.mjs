import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { loadDataset, parseJsonl } from './dataset.mjs';
import { validateCase, validateObservation } from './schema.mjs';

const dev = loadDataset({ splits: ['dev'] });
const row = dev.cases[0];
const serialized = JSON.stringify(row);

test('all three JSONL splits validate and match the versioned manifest', () => {
  const dataset = loadDataset({ splits: ['dev', 'holdout', 'adversarial'], includeHoldout: true });
  const manifest = JSON.parse(
    readFileSync(new URL('../../evals/v1/manifest.json', import.meta.url), 'utf8'),
  );
  for (const [split, count] of Object.entries(manifest.splits)) {
    expect(dataset.cases.filter((item) => item.split === split)).toHaveLength(count);
    expect(dataset.fingerprints[split]).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(new Set(dataset.cases.map((item) => item.id)).size).toBe(156);
});

test('development selection never includes holdout implicitly', () => {
  expect(loadDataset().splits).toEqual(['dev', 'adversarial']);
  expect(loadDataset().cases.every((item) => item.split !== 'holdout')).toBe(true);
  expect(() => loadDataset({ splits: ['holdout'] })).toThrow('explicit');
  expect(loadDataset({ splits: ['holdout'], includeHoldout: true }).cases).toHaveLength(54);
});

test.each([
  { splits: [] },
  { splits: ['dev', 'dev'] },
  { splits: ['../secret'] },
  { splits: ['unknown'] },
])('invalid split selections fail: %j', ({ splits }) => {
  expect(() => loadDataset({ splits })).toThrow();
});

test.each([
  '',
  '\n',
  `${serialized}\n\n`,
  `${serialized}\ninvalid`,
  `${serialized}\n${serialized}`,
])('empty, malformed and duplicate rows fail without echoing content', (text) => {
  expect(() => parseJsonl(text, 'dev')).toThrow();
});

test('LF and CRLF with a final newline are accepted', () => {
  expect(parseJsonl(serialized + '\r\n', 'dev')).toEqual([row]);
  expect(parseJsonl(serialized + '\n', 'dev')).toEqual([row]);
  expect(() => parseJsonl(serialized, 'holdout')).toThrow('row 1');
});

test.each([
  (value) => {
    value.schemaVersion = '2.0.0';
  },
  (value) => {
    value.unrecognized = 'field';
  },
  (value) => {
    value.principal.groups = ['operations', 'operations'];
  },
  (value) => {
    value.documents[0].webViewLink = 'not a URI';
  },
  (value) => {
    value.documents.push(value.documents[0]);
  },
  (value) => {
    value.expected.supportedSourceIds = ['unknown'];
  },
  (value) => {
    value.principal.groups = [];
  },
  (value) => {
    value.expected.supportedSourceIds = [];
  },
  (value) => {
    value.split = 'holdout';
  },
  (value) => {
    value.expected.trajectory[0].authorized = 'yes';
  },
])('schema and semantic constraints reject a corrupted key', (mutate) => {
  const value = structuredClone(row);
  mutate(value);
  expect(() => validateCase(value)).toThrow();
});

test('deferred memory cannot be labeled implemented by changing its key', () => {
  const memory = structuredClone(
    loadDataset().cases.find((item) => item.scenario === 'memory-deletion'),
  );
  memory.expected.status = 'denied';
  expect(() => validateCase(memory)).toThrow('P4-MEM');
});

test('observation input rejects unknown fields, missing evidence and invalid outcomes', () => {
  const observation = {
    schemaVersion: '1.0.0',
    caseId: row.id,
    status: 'answered',
    answer: 'text',
    citations: [],
    retrievedSourceIds: [],
    calls: [],
    diagnostics: [],
    workflow: 'complete',
  };
  expect(validateObservation(observation)).toEqual(observation);
  expect(() => validateObservation({ ...observation, extra: true })).toThrow();
  expect(() =>
    validateObservation({
      ...observation,
      calls: [{ tool: 'write', arguments: {}, authorized: true, outcome: 'maybe' }],
    }),
  ).toThrow();
  expect(() => validateObservation({ ...observation, answer: null })).toThrow();
});
