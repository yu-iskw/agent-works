import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { recordedBackend } from './evidence.mjs';
import { runGateway } from './run-gateway.mjs';

const baseline = JSON.parse(
  readFileSync(new URL('./fixtures/scenarios.json', import.meta.url)),
).baseline;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/valid.json', import.meta.url)));

test('Gateway run imports #112 proof before replaying its own adapter', async () => {
  const result = await runGateway('bounded-read', baseline, recordedBackend([fixture]));
  assert.equal(result.proof.liveValidation, 'UNVERIFIED');
  assert.equal(result.result.ok, true);
});

test('invalid upstream principal proof fails closed before Gateway call', async () => {
  let calls = 0;
  await assert.rejects(
    runGateway(
      'bounded-read',
      baseline,
      {
        async exchange() {
          calls += 1;
          return {};
        },
      },
      '{}',
    ),
    /rejected/,
  );
  assert.equal(calls, 0);
});

test('Gateway adapter receives the #112 digest and separated workload scope', async () => {
  const recording = recordedBackend([fixture]);
  let context;
  const backend = {
    async exchange(id, fields, proof) {
      context = proof;
      return recording.exchange(id, fields);
    },
  };
  await runGateway('bounded-read', baseline, backend);
  assert.equal(context.principal, 'agent-a');
  assert.equal(context.caller, 'user-a');
  assert.equal(context.scope, 'read');
  assert.equal(context.authoritySeparated, true);
  assert.equal(context.liveValidation, 'UNVERIFIED');
  assert.match(context.evidenceDigest, /^[a-f0-9]{64}$/);
});
