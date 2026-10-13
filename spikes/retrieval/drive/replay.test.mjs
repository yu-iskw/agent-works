import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

import { readJson } from '../compare/fixture-tools.ts';
import { parseEvidence } from '../compare/schema.ts';
import { driveRecordingSchema, replayTransport } from './schema.ts';

const directory = new URL('./fixtures/', import.meta.url);
const names = readdirSync(directory)
  .filter(
    (name) =>
      name.endsWith('.json') && name !== 'evidence.json' && !name.endsWith('.transcript.json'),
  )
  .sort();

for (const name of names) {
  test(`Drive recording schema: ${name}`, () => {
    const recording = driveRecordingSchema.parse(readJson(new URL(name, directory)));
    assert.equal(recording.provenance, 'synthetic');
    assert.ok(recording.exchanges.length > 0);
    assert.equal(JSON.stringify(recording).includes('ya29.'), false);
  });
}

test('fake transport requires own delegated credential and exact request sequence', async () => {
  const replay = replayTransport(readJson(new URL('outsider.json', directory)));
  const response = await replay.load(new URL('https://www.googleapis.com/drive/v3/files'), {
    headers: { authorization: 'Bearer FAKE_REDACTED_DELEGATED' },
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { files: [{ id: 'public' }] });
  assert.equal(replay.requests[0].delegated, true);
  await assert.rejects(
    replay.load('https://evil.example/drive/v3/files'),
    /unexpected replay request/,
  );
});

test('fake transport refuses omitted or blanket identity', async () => {
  const recording = readJson(new URL('outsider.json', directory));
  await assert.rejects(
    replayTransport(recording).load('https://www.googleapis.com/drive/v3/files'),
    /missing delegated credential/,
  );
  await assert.rejects(
    replayTransport(recording).load('https://www.googleapis.com/drive/v3/files', {
      headers: { authorization: 'Bearer FAKE_SERVICE_ACCOUNT' },
      redirect: 'error',
    }),
    /missing delegated credential/,
  );
});

test('schema rejects mislabeled live responses, malformed records and unknown fields', () => {
  const raw = readJson(new URL('alice.json', directory));
  assert.throws(() => driveRecordingSchema.parse({ ...raw, provenance: 'observed' }));
  assert.throws(() => driveRecordingSchema.parse({ ...raw, token: 'FAKE_SECRET' }));
  const malformed = structuredClone(raw);
  malformed.exchanges[1].body.version = 'not-a-version';
  assert.throws(() => driveRecordingSchema.parse(malformed));
});

test('Drive report leaves all live measurements unverified', () => {
  const evidence = parseEvidence(readJson(new URL('evidence.json', directory)));
  assert.equal(evidence.arm, 'B');
  assert.equal(evidence.verdict, 'UNVERIFIED');
  assert.equal(evidence.availability, 'not-probed');
  assert.equal(evidence.costUsd, null);
  assert.deepEqual(evidence.cases, []);
});

test('revocation poll requires repeated successful denial and preserves sampling interval', async () => {
  const { pollRevocation } = await import('./revocation.ts');
  let at = Date.parse('2026-10-13T00:00:00Z');
  const result = await pollRevocation({
    changedAt: new Date(at).toISOString(),
    sourceObjectId: 'reviewer-shared',
    attempts: 3,
    intervalMs: 1000,
    recheckDenied: () => Promise.resolve(true),
    now: () => at,
    wait: (ms) => {
      at += ms;
      return Promise.resolve();
    },
  });
  assert.equal(result.revocationLagMs, 0);
  assert.equal(result.intervalMs, 1000);
  assert.equal(result.stable, true);
  assert.equal(result.checks.length, 3);
});

test('failed polling is unavailable evidence, never a successful revoke', async () => {
  const { pollRevocation } = await import('./revocation.ts');
  await assert.rejects(
    pollRevocation({
      changedAt: '2026-10-13T00:00:00Z',
      sourceObjectId: 'reviewer-shared',
      attempts: 2,
      intervalMs: 1000,
      recheckDenied: () => Promise.reject(new Error('unavailable')),
    }),
    /unavailable/,
  );
  await assert.rejects(
    pollRevocation({
      changedAt: '2026-10-13T00:00:00Z',
      sourceObjectId: 'reviewer-shared',
      attempts: 1,
      intervalMs: 1000,
      recheckDenied: () => Promise.resolve(true),
    }),
    /invalid polling budget/,
  );
});

test('operator probe rejects a mismatched identity before loading the adapter', async () => {
  const { probeDrive } = await import('./probe.ts');
  await assert.rejects(
    probeDrive({ caller: { sub: 'real-alice' } }, {}, 'bob', {
      callerSubject: 'real-alice',
      subjectAlias: 'alice',
      sourceAliases: {},
    }),
    /identity binding mismatch/,
  );
});
