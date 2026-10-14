import { runnerLimitsSchema } from '@agent-works/domain';
import { expect, test, vi } from 'vitest';

import { createAdkRunner } from '../agent/adk-runner.js';
import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createListener } from '../http.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { RetrievalError } from '../retrieval/drive-port.js';

import { publishBundledCapabilities } from './bootstrap.js';
import { createSuspensionEnforcer } from './enforcement.js';
import { listenerFetch } from './http-test-harness.js';
import {
  authorizeResource,
  beforeReadTool,
  beforeToolCall,
  bundledVersionBaseline,
  controlledListener,
  controlledRunner,
  controlledSkill,
  controlledVerify,
} from './runtime.js';
import { suspendCommand, testAt, versionCommand } from './test-fixtures.js';

import type { Caller } from '../auth/iap.js';
import type { ExecuteInput } from '../broker/broker.js';
import type { RegisteredSkill } from '../skills/incident.js';
import type { InvocationContext } from '@agent-works/policy';

const manifest = {
  id: 'incident',
  version: '1',
  state: 'PUBLISHED' as const,
  tools: ['ticket.create'],
};
const request = {
  objective: 'triage',
  skillId: 'incident',
  sourceAllowlist: ['incidents'],
  requestedOutputs: ['ticket'],
  executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 30 },
};
const accepted = {
  taskId: 'task',
  traceId: 'trace',
  status: 'QUEUED' as const,
  submittedAt: testAt.toISOString(),
  statusUrl: '/v1/tasks/task',
};
const authorized = {
  caller: { sub: 'alice', assertion: 'verified' } as Caller,
  decision: { effect: 'allow' as const, decisionId: 'decision', policyVersion: '1' },
  context: {
    userSubject: 'alice',
    enterpriseId: 'enterprise',
    authorizedGroups: ['engineering'],
    groupsObservedAt: testAt.toISOString(),
    allowedSources: ['incidents'],
    taskPurpose: 'triage',
    classificationCeiling: 'INTERNAL' as const,
    allowedRegions: ['asia-northeast1'],
    resultCountLimit: 10,
  },
};
const limits = runnerLimitsSchema.parse({
  maxSteps: 4,
  maxToolCalls: 4,
  maxCostUsd: 1,
  maxElapsedMs: 1000,
  maxBytesRetrieved: 1000,
  maxGeneratedOutputs: 1,
  maxModelRetries: 1,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
});
const answer = { candidates: [{ content: { parts: [{ text: 'Done' }] }, finishReason: 'STOP' }] };

async function setup(operation: RegisteredSkill['dispatch']) {
  const ledger = createMemorySuspensionLedger();
  await publishBundledCapabilities(ledger, bundledVersionBaseline(manifest));
  const enforcer = createSuspensionEnforcer({ ledger });
  const skill = controlledSkill(
    { manifest, validate: () => true, dispatch: operation },
    enforcer,
    () => Promise.resolve({ groups: ['engineering'] }),
    'gemini',
  );
  return { ledger, skill, enforcer };
}
test('scripted runner checks the injected hook before fetch', async () => {
  const load = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
  const beforeModelCall = vi.fn().mockRejectedValue(new Error('CAPABILITY_VERSION_REVOKED'));
  const runner = createScriptedRunner({ baseUrl: 'http://localhost', fetch: load });
  await expect(runner.run({ question: 'triage', sources: [], beforeModelCall })).rejects.toThrow(
    'CAPABILITY_VERSION_REVOKED',
  );
  expect(beforeModelCall).toHaveBeenCalledExactlyOnceWith('gemini');
  expect(load).not.toHaveBeenCalled();
});
test('ADK invokes the injected revocation hook before every turn', async () => {
  const load = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      candidates: [{ content: { parts: [{ functionCall: { name: 'search' } }] } }],
    }),
  );
  let checks = 0;
  const beforeModelCall = () => {
    checks += 1;
    return checks === 2
      ? Promise.reject(new Error('CAPABILITY_VERSION_REVOKED'))
      : Promise.resolve();
  };
  await expect(
    createAdkRunner({ baseUrl: 'http://localhost', fetch: load, limits }).run({
      question: 'triage',
      sources: [],
      beforeModelCall,
    }),
  ).rejects.toThrow('CAPABILITY_VERSION_REVOKED');
  expect(checks).toBe(2);
  expect(load).toHaveBeenCalledOnce();
});
test('ADK runner created inside a skill still receives the request-scoped default hook', async () => {
  const load = vi.fn<typeof fetch>();
  const app = await setup(async () => {
    await createAdkRunner({ baseUrl: 'http://localhost', fetch: load, limits }).run({
      question: 'triage',
      sources: [],
    });
  });
  await app.ledger.change(
    suspendCommand({ scope: 'model', id: 'gemini', version: null }),
    'operator',
    testAt,
  );
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toThrow(
    'INVOCATION_SUSPENDED',
  );
  expect(load).not.toHaveBeenCalled();
});
test('revocation after the first model turn prevents the second turn and records controlled task stop', async () => {
  const load = vi.fn<typeof fetch>();
  const app = await setup(async () => {
    await createAdkRunner({ baseUrl: 'http://localhost', fetch: load, limits }).run({
      question: 'triage',
      sources: [],
    });
  });
  load.mockImplementation(async () => {
    await app.ledger.change(
      versionCommand({ kind: 'skill', id: 'incident', version: '1' }, 'revoked', 2),
      'operator',
      testAt,
    );
    return Response.json({
      candidates: [{ content: { parts: [{ functionCall: { name: 'search' } }] } }],
    });
  });
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toThrow(
    'CAPABILITY_VERSION_REVOKED',
  );
  expect(load).toHaveBeenCalledOnce();
  const result = (app.skill as RegisteredSkill & { result(id: string): unknown }).result('task');
  expect(result).toEqual({ kind: 'revoked' });
  expect(
    (await app.ledger.history()).filter((event) => event.eventType === 'invocation.denied'),
  ).toHaveLength(1);
});
test('a swallowed inner denial is latched so the dispatcher still sees revoked', async () => {
  const load = vi.fn<typeof fetch>();
  const app = await setup(async () => {
    await app.ledger.change(
      versionCommand({ kind: 'skill', id: 'incident', version: '1' }, 'revoked', 2),
      'operator',
      testAt,
    );
    try {
      await createScriptedRunner({ baseUrl: 'http://localhost', fetch: load }).run({
        question: 'triage',
        sources: [],
      });
    } catch {
      /* Existing skills normalize delivery errors. */
    }
  });
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toThrow(
    'CAPABILITY_VERSION_REVOKED',
  );
  expect((app.skill as RegisteredSkill & { result(id: string): unknown }).result('task')).toEqual({
    kind: 'revoked',
  });
  expect(load).not.toHaveBeenCalled();
});
test('ordinary skill errors retain their original failure semantics', async () => {
  const app = await setup(() => Promise.reject(new Error('network failure')));
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toThrow(
    'network failure',
  );
  expect(
    (app.skill as RegisteredSkill & { result(id: string): unknown }).result('task'),
  ).toBeUndefined();
});
test('broker hook receives pinned capability and trusted actor in skill scope', async () => {
  const app = await setup(async () => {
    await beforeToolCall({
      actorSub: 'alice',
      taskId: 'task',
      traceId: 'trace',
      toolRef: 'ticket.create@1',
    } as ExecuteInput);
  });
  await app.ledger.change(
    suspendCommand({ scope: 'tool', id: 'ticket.create', version: '1' }),
    'operator',
    testAt,
  );
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toThrow(
    'INVOCATION_SUSPENDED',
  );
});
test('runner without trusted invocation context fails closed', async () => {
  const ledger = createMemorySuspensionLedger();
  const load = vi.fn<typeof fetch>();
  const runner = controlledRunner(
    createScriptedRunner({ baseUrl: 'http://localhost', fetch: load }),
    createSuspensionEnforcer({ ledger }),
  );
  await expect(runner.run({ question: 'triage', sources: [] })).rejects.toThrow(
    'SUSPENSION_CONTEXT_MISSING',
  );
  expect(load).not.toHaveBeenCalled();
});
test('concurrent request scopes keep subjects and teams isolated', async () => {
  const ledger = createMemorySuspensionLedger();
  await publishBundledCapabilities(ledger, bundledVersionBaseline(manifest));
  const seen: InvocationContext[] = [];
  const enforcer = {
    check: (context: InvocationContext) => {
      seen.push(structuredClone(context));
      return Promise.resolve();
    },
  };
  const verify = controlledVerify(
    (assertion) => Promise.resolve({ sub: assertion, assertion } as Caller),
    (sub) => Promise.resolve({ groups: [`team:${sub}`] }),
    enforcer,
  );
  const listener = createListener({
    'GET /v1/ask': async (req) => {
      const caller = await verify(req.headers['x-goog-iap-jwt-assertion'] as string);
      await authorizeResource(undefined, 'gemini');
      await createScriptedRunner({
        baseUrl: 'http://localhost',
        fetch: () => Promise.resolve(Response.json(answer)),
      }).run({ question: caller.sub, sources: [] });
      return { status: 200, body: 'ok' };
    },
  });
  const fetch = listenerFetch(controlledListener(listener, enforcer));
  try {
    await Promise.all(
      ['alice', 'bob'].map((sub) =>
        fetch('http://127.0.0.1:8084/v1/ask', { headers: { 'x-goog-iap-jwt-assertion': sub } }),
      ),
    );
    expect(seen).toHaveLength(6);
    for (const context of seen) expect(context.teams).toEqual([`team:${context.subject}`]);
    expect(new Set(seen.map((context) => context.subject))).toEqual(new Set(['alice', 'bob']));
  } finally {
    /* No kernel socket to release. */
  }
});

test('a read-tool stop becomes a controlled retrieval error and retains the task stop latch', async () => {
  const readTransport = vi.fn();
  const app = await setup(async () => {
    await app.ledger.change(
      suspendCommand({ scope: 'tool', id: 'drive.search', version: '1' }),
      'operator',
      testAt,
    );
    await beforeReadTool();
    readTransport();
  });
  await expect(app.skill.dispatch(request, accepted, authorized)).rejects.toBeInstanceOf(
    RetrievalError,
  );
  expect(readTransport).not.toHaveBeenCalled();
  expect((app.skill as RegisteredSkill & { result(id: string): unknown }).result('task')).toEqual({
    kind: 'revoked',
  });
  const denied = (await app.ledger.history()).filter(
    (event) => event.eventType === 'invocation.denied',
  );
  expect(denied).toHaveLength(1);
  expect(denied[0]).toMatchObject({
    reason: 'INVOCATION_SUSPENDED',
    taskId: 'task',
    details: { kind: 'tool' },
  });
});
