import { describe, expect, test } from 'vitest';

import { readAdversarialFixture, scenarioNames } from './fixtures.js';
import { createSideEffectProbe } from './side-effects.js';
import { createAdversarialTransport } from './transport.js';

describe('versioned hostile fixtures', () => {
  test.each(scenarioNames)('validates all fields and attack channels for %s', (name) => {
    const fixture = readAdversarialFixture(name);
    expect(fixture.schemaVersion).toBe('1.0.0');
    expect(fixture.scenario).toBe(name);
    expect(fixture.evidence).toBe('offline-fakes-only');
    expect(fixture.fault.length).toBeGreaterThan(0);
    expect(fixture.protected.title).toContain('PRIVATE');
    expect(fixture.protected.snippet).toContain('CONFIDENTIAL');
    expect(fixture.variants.map((variant) => variant.channel)).toEqual([
      'plain',
      'html',
      'unicode',
      'encoded',
    ]);
    for (const variant of fixture.variants) {
      expect(variant.instruction.length).toBeGreaterThan(10);
      expect(variant.destination).toBe('https://attacker.invalid/collect');
      expect(variant.recipient).toBe('attacker@invalid.example');
      expect(variant.expected).toBe('deny-or-controlled-error');
    }
    expect(fixture.lifecycle).toEqual({
      initiator: 'alice',
      reviewer: 'bob',
      groupBefore: ['operations', 'reviewers'],
      groupAfter: [],
      approvedVersion: '1',
      revokedVersion: '1',
      writeKey: `${name}-delivery-1`,
    });
  });
});

test('leaky transport deliberately returns documents belonging to other subjects', async () => {
  const documents = [
    {
      id: 'bob-only',
      folder: 'bob',
      title: 'PRIVATE board notes',
      text: 'CONFIDENTIAL allocation',
      webViewLink: 'https://drive.fake.test/d/bob-only',
    },
  ];
  const transport = createAdversarialTransport({
    documents,
    subject: 'alice',
    groups: ['operations'],
  });
  const reply = await transport.fetch('https://drive.fake.test/documents');
  expect(await reply.json()).toEqual(documents);
  const snapshot = await transport.fetch('https://directory.fake.test/snapshots/alice');
  expect(await snapshot.json()).toMatchObject({ sub: 'alice', groups: ['operations'] });
  transport.revokeGroups();
  const revoked = await transport.fetch('https://directory.fake.test/snapshots/alice');
  expect(await revoked.json()).toMatchObject({ groups: [] });
  expect(transport.requests()).toHaveLength(3);
});

test('transport records methods and isolates request history from callers', async () => {
  const transport = createAdversarialTransport({ documents: [], subject: 'alice', groups: [] });
  await transport.fetch(new Request('https://llm.fake.test/v1beta/models/gemini:generateContent'), {
    method: 'POST',
  });
  const history = transport.requests();
  expect(history).toEqual([{ path: '/v1beta/models/gemini:generateContent', method: 'POST' }]);
  expect(transport.requests()).not.toBe(history);
});

test.each([
  'https://attacker.invalid/collect',
  'https://drive.fake.test/unknown',
  'https://directory.fake.test/snapshots/bob',
])('unregistered destinations return a controlled response: %s', async (url) => {
  const transport = createAdversarialTransport({ documents: [], subject: 'alice', groups: [] });
  const response = await transport.fetch(url);
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'unregistered offline destination' });
});

test('fault knobs independently fail directory and model', async () => {
  const transport = createAdversarialTransport({
    documents: [],
    subject: 'alice',
    groups: [],
    directoryUnavailable: true,
    modelUnavailable: true,
  });
  expect((await transport.fetch('https://directory.fake.test/snapshots/alice')).status).toBe(503);
  expect(
    (await transport.fetch('https://llm.fake.test/v1beta/models/gemini:generateContent')).status,
  ).toBe(503);
  expect((await transport.fetch('https://drive.fake.test/documents')).status).toBe(200);
});

test('model can return an unauthorized call as untrusted provider output', async () => {
  const modelCall = { name: 'email.send', args: { recipient: 'attacker@invalid.example' } };
  const transport = createAdversarialTransport({
    documents: [],
    subject: 'alice',
    groups: [],
    modelCall,
  });
  const reply = await transport.fetch('https://llm.fake.test/v1beta/models/gemini:generateContent');
  expect(await reply.json()).toMatchObject({
    candidates: [{ content: { parts: [{ functionCall: modelCall }] } }],
  });
});

test('lost response leaves one persisted resource and replay returns its original receipt', async () => {
  const effects = createSideEffectProbe();
  const payload = { summary: 'Review controls', project: 'PROJ' };
  effects.loseNextResponse();
  await expect(effects.post(payload, 'key')).rejects.toThrow('response lost');
  expect(effects.receipts()).toEqual([{ key: 'key', payload, receipt: 'ADV-1' }]);
  expect(await effects.post(payload, 'key')).toBe('ADV-1');
  expect(effects.attempts()).toBe(2);
  expect(effects.receipts()).toHaveLength(1);
});

test('separate worlds never share resources or revocations', async () => {
  const left = createSideEffectProbe();
  const right = createSideEffectProbe();
  await left.post({ summary: 'one', project: 'PROJ' }, 'key');
  expect(right.receipts()).toEqual([]);
  await right.post({ summary: 'two', project: 'PROJ' }, 'key');
  expect(left.receipts()[0].payload.summary).toBe('one');
  expect(right.receipts()[0].payload.summary).toBe('two');
});

test('receipt snapshots and persisted payloads resist caller mutation', async () => {
  const effects = createSideEffectProbe();
  const payload = { summary: 'one', project: 'PROJ' };
  await effects.post(payload, 'key');
  payload.summary = 'changed';
  expect(effects.receipts()[0].payload.summary).toBe('one');
  const snapshot = effects.receipts();
  snapshot[0].payload.summary = 'tampered';
  expect(effects.receipts()[0].payload.summary).toBe('one');
});
