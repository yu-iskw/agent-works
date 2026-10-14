import { expect, test } from 'vitest';

import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';

import { publishBundledCapabilities } from './bootstrap.js';
import { bundledVersionBaseline } from './runtime.js';
import { testAt, versionCommand } from './test-fixtures.js';

const baseline = bundledVersionBaseline({
  id: 'incident',
  version: '1',
  tools: ['ticket.create'],
  state: 'PUBLISHED',
});
test('release registers bundled pins through draft and published exactly once', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishBundledCapabilities(ledger, baseline);
  expect((await ledger.snapshot()).versions).toHaveLength(5);
  expect((await ledger.snapshot()).versions.every((value) => value.state === 'published')).toBe(
    true,
  );
  expect(await ledger.history()).toHaveLength(10);
  await publishBundledCapabilities(ledger, baseline);
  expect(await ledger.history()).toHaveLength(10);
});
test('restart honors revocation and does not resurrect a bundled capability', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishBundledCapabilities(ledger, baseline);
  await ledger.change(versionCommand(baseline[0].pin, 'revoked', 2), 'operator', testAt);
  await publishBundledCapabilities(ledger, baseline);
  expect((await ledger.snapshot()).versions.find((value) => value.pin.id === 'api')?.state).toBe(
    'revoked',
  );
  expect(await ledger.history()).toHaveLength(11);
});
test('concurrent startup and outage are safe', async () => {
  const ledger = createMemorySuspensionLedger();
  await Promise.all([
    publishBundledCapabilities(ledger, baseline),
    publishBundledCapabilities(ledger, baseline),
  ]);
  expect((await ledger.snapshot()).versions).toHaveLength(5);
  expect(await ledger.history()).toHaveLength(10);
  ledger.snapshot = () => Promise.reject(new Error('store unavailable'));
  await expect(publishBundledCapabilities(ledger, baseline)).rejects.toThrow('store unavailable');
});

test('release bootstrap never publishes a bundled draft skill', async () => {
  const ledger = createMemorySuspensionLedger();
  const draft = bundledVersionBaseline({
    id: 'unreviewed',
    version: '1',
    tools: ['ticket.create'],
    state: 'DRAFT',
  });
  await publishBundledCapabilities(ledger, draft);
  const snapshot = await ledger.snapshot();
  expect(snapshot.versions.find((value) => value.pin.id === 'unreviewed')).toBeUndefined();
  expect(snapshot.versions).toHaveLength(4);
  expect(await ledger.history()).toHaveLength(8);
});
