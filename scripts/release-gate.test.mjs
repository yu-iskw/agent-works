import { spawnSync } from 'node:child_process';

import { expect, test } from 'vitest';

// Existing root scripts project discovers these suites without changing Vitest config.
import '../tools/evals/dataset.test.mjs';
import '../tools/evals/gate.test.mjs';
import '../tools/evals/scorer.test.mjs';
import { parseGateArgs } from './release-gate.mjs';

function run(args) {
  return spawnSync(process.execPath, ['scripts/release-gate.mjs', '--no-write', ...args], {
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('current repository implementations pass the default offline dataset', () => {
  const result = run([]);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    cases: 102,
    deferred: 4,
    gate: { passed: true, realServicesGatePassed: false },
  });
}, 30000);

test.each(['leak', 'unapproved-call'])(
  'seeded %s regression exits nonzero with security evidence',
  (seed) => {
    const result = run(['--regression', seed]);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.failures.some((failure) => failure.startsWith('security:'))).toBe(true);
  },
  30000,
);

test('holdout requires an explicit CLI flag and executes the separate split', () => {
  const result = run(['--include-holdout']);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).cases).toBe(156);
}, 30000);

test.each([
  ['--unknown'],
  ['--regression'],
  ['--regression', '../../secret'],
  ['--include-holdout', '--include-holdout'],
])('CLI fails closed for invalid arguments: %j', (args) => {
  expect(() => parseGateArgs(args)).toThrow();
  expect(run(args).status).toBe(2);
});

test('argument parsing keeps holdout opt-in and result writes explicit', () => {
  expect(parseGateArgs([])).toEqual({
    includeHoldout: false,
    regression: null,
    writeResults: true,
  });
  expect(parseGateArgs(['--include-holdout', '--no-write', '--regression', 'leak'])).toEqual({
    includeHoldout: true,
    regression: 'leak',
    writeResults: false,
  });
});

function probe(body) {
  const source = `
    import { loadRuntime } from './tools/evals/runtime.mjs';
    const api = await loadRuntime();
    const result = await (async () => { ${body} })();
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

test('lost response after persistence resumes without creating a second resource', () => {
  const result = probe(`
    const world = await api.createBrokerWorld();
    world.effects.loseNextResponse();
    let lost = false;
    try { await world.broker.execute(world.input); } catch { lost = true; }
    const afterLoss = world.effects.receipts().length;
    const resumed = await world.broker.execute(world.input);
    const replayed = await world.broker.execute(world.input);
    const approval = await world.store.read(world.input.approvalId);
    return { lost, afterLoss, resumed, replayed, attempts: world.effects.attempts(), resources: world.effects.receipts().length, uses: approval.executionsUsed };
  `);
  expect(result).toEqual({
    lost: true,
    afterLoss: 1,
    resumed: { ok: true, receipt: 'ADV-1', replay: false },
    replayed: { ok: true, receipt: 'ADV-1', replay: true },
    attempts: 2,
    resources: 1,
    uses: 1,
  });
}, 30000);

test('concurrent deliveries share a key and cannot dispatch a second write', () => {
  const result = probe(`
    const world = await api.createBrokerWorld();
    const replies = await Promise.all([
      world.broker.execute(world.input),
      world.broker.execute({ ...world.input, id: 'another-call' }),
    ]);
    return { replies, attempts: world.effects.attempts(), resources: world.effects.receipts().length };
  `);
  expect(result.replies).toEqual(
    expect.arrayContaining([
      { ok: true, receipt: 'ADV-1', replay: false },
      { ok: false, status: 409, code: 'DUPLICATE_CALL' },
    ]),
  );
  expect(result.attempts).toBe(1);
  expect(result.resources).toBe(1);
}, 30000);

test.each(['policyUnavailable', 'brokerUnavailable'])(
  'unavailable %s prevents actual side-effect dispatch',
  (fault) => {
    const result = probe(`
    const world = await api.createBrokerWorld({ ${fault}: true });
    let controlled = false;
    try { await world.broker.execute(world.input); } catch (error) { controlled = error.message.includes('unavailable'); }
    return { controlled, attempts: world.effects.attempts(), resources: world.effects.receipts().length };
  `);
    expect(result).toEqual({ controlled: true, attempts: 0, resources: 0 });
  },
  30000,
);

test('reviewer removal denies both approval binding and subsequent execution', () => {
  const result = probe(`
    const world = await api.createBrokerWorld();
    world.removeReviewer();
    const bind = await world.broker.bindApproval(world.input.approvalId, { actorSub: 'bob', decision: 'approve', expectedPayloadSha256: world.digest });
    const execute = await world.broker.execute(world.input);
    return { bind, execute, attempts: world.effects.attempts() };
  `);
  expect(result.bind).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
  expect(result.execute).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
  expect(result.attempts).toBe(0);
}, 30000);

test('payload and recipient changes are denied with zero external attempts', () => {
  const result = probe(`
    const world = await api.createBrokerWorld();
    const payload = await world.broker.execute({ ...world.input, payload: { summary: 'changed', project: 'PROJ' } });
    const recipient = await world.broker.execute({ ...world.input, targetResource: 'ATTACKER', payload: { summary: 'Review controls', project: 'ATTACKER' } });
    return { payload, recipient, attempts: world.effects.attempts() };
  `);
  expect(result.payload).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
  expect(result.recipient).toEqual({ ok: false, status: 422, code: 'APPROVAL_REQUIRED' });
  expect(result.attempts).toBe(0);
}, 30000);
