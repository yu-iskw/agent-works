import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, expect, it } from 'vitest';
import * as z from 'zod';

import { createMemoryTaskPorts } from '../../apps/api/src/ports/memory/task-ports.js';
import { createSkillRegistry } from '../../apps/api/src/skills/registry.js';
import { createTaskDispatcher } from '../../apps/api/src/skills/task-dispatcher.js';
import { startStack } from '../../apps/api/src/testing/stack.js';
import { taskAuthorization } from '../../apps/api/src/testing/task-authorization.js';
import { appendResult } from '../results.mjs';

import type { Stack } from '../../apps/api/src/testing/stack.js';

const taskApiPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../contracts/schemas/task-api.json',
);

const published = z.fromJSONSchema(JSON.parse(readFileSync(taskApiPath, 'utf8')));

const submit = {
  kind: 'submit',
  objective: 'Summarize the runbook',
  skillId: 'contract-test',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let stack: Stack;
const ports = createMemoryTaskPorts();
let worker: ReturnType<typeof createTaskDispatcher>;
let cancelStarted = () => {};
let finishCancelled = () => {};

beforeAll(async () => {
  process.env.AW_TASKS = 'real';
  process.env.AW_TASKS_READ = 'real';
  process.env.AW_TASKS_EVENTS = 'real';
  const skills = createSkillRegistry([
    {
      manifest: { id: 'contract-test', version: '1', state: 'PUBLISHED', tools: ['drive.search'] },
      validate: () => true,
      dispatch: (request) => {
        if (request.objective === 'fail') return Promise.reject(new Error('model offline'));
        if (request.objective === 'cancel') {
          cancelStarted();
          return new Promise<void>((resolve) => {
            finishCancelled = resolve;
          });
        }
        return Promise.resolve();
      },
    },
  ]);
  worker = createTaskDispatcher({ ...ports, registry: skills, maxAttempts: 1 });
  process.env.AW_TASKS_CANCEL = 'real';
  stack = await startStack({
    skills,
    dispatch: ports.dispatch,
    wire: {
      ...taskAuthorization.wire,
      ledger: ports.ledger,
      search: { search: () => Promise.resolve([]) },
    },
  });
  process.env.IAP_JWKS_URL = `${stack.iapUrl}/jwks`;
  process.env.IAP_ISSUER = 'https://fake-iap.local';
  process.env.IAP_AUDIENCE = 'agent-works-dev';
});

afterAll(async () => {
  await worker?.stop();
  await stack?.close();
  delete process.env.AW_TASKS;
  delete process.env.AW_TASKS_READ;
  delete process.env.AW_TASKS_EVENTS;
  delete process.env.AW_TASKS_CANCEL;
});

it('task.lifecycle', async () => {
  const key = randomUUID();
  const created = await postTask(submit, 'alice', key);
  expect(created.status).toBe(200);
  const accepted: unknown = created.body;
  expect(published.safeParse(accepted).success).toBe(true);
  expect(accepted).toMatchObject({ kind: 'accepted', status: 'QUEUED' });
  const taskId = taskIdOf(accepted);

  expect(await worker.runOnce()).toBe(true);
  const read = await getJson(`/v1/tasks/${taskId}`, 'alice');
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({
    id: taskId,
    status: 'COMPLETED',
    createdBySub: 'alice',
    version: 3,
  });

  const events = await getJson(`/v1/tasks/${taskId}/events`, 'alice');
  expect(events.status).toBe(200);
  expect(events.body).toMatchObject({
    events: expect.arrayContaining([
      expect.objectContaining({
        destination: 'work',
        event: expect.objectContaining({
          taskId,
          stepId: 'submit',
          initiatorSubject: 'alice',
          outcome: 'SUCCESS',
        }),
      }),
      expect.objectContaining({ event: expect.objectContaining({ eventType: 'task.running' }) }),
      expect.objectContaining({ event: expect.objectContaining({ eventType: 'task.completed' }) }),
    ]),
  });

  const replay = await postTask(submit, 'alice', key);
  expect(replay.status).toBe(200);
  expect(taskIdOf(replay.body)).toBe(taskId);

  const changed = await postTask({ ...submit, objective: 'A different objective' }, 'alice', key);
  expect(changed.status).toBe(409);
  expect(changed.body).toEqual({ error: 'conflict' });

  const hidden = await getJson(`/v1/tasks/${taskId}`, 'bob');
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual({ error: 'not_found' });

  const missing = await fetch(`${stack.apiUrl}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submit),
  });
  expect(missing.status).toBe(401);
  expect(await missing.json()).toEqual({ error: 'unauthenticated' });

  const forged = await fetch(`${stack.apiUrl}/v1/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      'x-goog-iap-jwt-assertion': forgedAssertion('alice'),
    },
    body: JSON.stringify(submit),
  });
  expect(forged.status).toBe(401);
  expect(await forged.json()).toEqual({ error: 'unauthenticated' });

  const badSig = await fetch(`${stack.iapUrl}/v1/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fake-user': 'alice',
      'x-fake-iap': 'bad-sig',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(submit),
  });
  expect(badSig.status).toBe(401);

  const noKey = await fetch(`${stack.iapUrl}/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fake-user': 'alice' },
    body: JSON.stringify(submit),
  });
  expect(noKey.status).toBe(400);
  expect(await noKey.json()).toEqual({ error: 'invalid_request' });

  appendResult({ id: 'task.lifecycle', status: 'passed' });
});

it('task.trusted-field-422', async () => {
  for (const field of ['userId', 'agentIdentity', 'scopes'] as const) {
    const response = await postTask({ ...submit, [field]: 'alice' }, 'alice', randomUUID());
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: 'untrusted_field' });
  }
  appendResult({ id: 'task.trusted-field-422', status: 'passed' });
});

async function postTask(
  body: unknown,
  user: string,
  idempotencyKey: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${stack.iapUrl}/v1/tasks`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fake-user': user,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function getJson(path: string, user: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${stack.iapUrl}${path}`, {
    headers: { 'x-fake-user': user },
  });
  return { status: response.status, body: await response.json() };
}

function forgedAssertion(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `x.${payload}.y`;
}

function taskIdOf(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('taskId' in body)) {
    throw new Error('taskId');
  }
  const { taskId } = body;
  if (typeof taskId !== 'string') throw new Error('taskId');
  return taskId;
}

it('task.failed-lifecycle', async () => {
  const created = await postTask({ ...submit, objective: 'fail' }, 'alice', randomUUID());
  const taskId = taskIdOf(created.body);
  expect(await worker.runOnce()).toBe(true);
  expect((await getJson(`/v1/tasks/${taskId}`, 'alice')).body).toMatchObject({
    status: 'FAILED',
    version: 3,
  });
  expect((await getJson(`/v1/tasks/${taskId}/events`, 'alice')).body).toMatchObject({
    events: expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({ eventType: 'task.failed', outcome: 'FAILURE' }),
      }),
    ]),
  });
});

it('task.cancel-lifecycle rejects late success', async () => {
  const created = await postTask({ ...submit, objective: 'cancel' }, 'alice', randomUUID());
  const taskId = taskIdOf(created.body);
  const started = new Promise<void>((resolve) => {
    cancelStarted = resolve;
  });
  const running = worker.runOnce();
  await started;
  try {
    const cancelled = await fetch(`${stack.iapUrl}/v1/tasks/${taskId}:cancel`, {
      method: 'POST',
      headers: { 'x-fake-user': 'alice', 'idempotency-key': randomUUID() },
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'CANCELLED' });
  } finally {
    finishCancelled();
    await running;
  }
  expect((await getJson(`/v1/tasks/${taskId}`, 'alice')).body).toMatchObject({
    status: 'CANCELLED',
    version: 3,
  });
  expect(await ports.ledger.readOutbox(`dispatch:${taskId}:3`)).toBeUndefined();
});

it('task.local-load submit-to-persisted-ID p95 is below 3 seconds', async () => {
  const durations: number[] = [];
  const ids: string[] = [];
  for (let batch = 0; batch < 5; batch += 1) {
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const start = performance.now();
        const accepted = await postTask(submit, 'alice', randomUUID());
        const taskId = taskIdOf(accepted.body);
        const persisted = await ports.ledger.read('alice', taskId);
        durations.push(performance.now() - start);
        expect(accepted.status).toBe(200);
        expect(persisted).toMatchObject({ id: taskId, status: 'QUEUED' });
        ids.push(taskId);
      }),
    );
  }
  expect(new Set(ids).size).toBe(40);
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  expect(p95).toBeLessThan(3000);
  console.info(`task.local-load: 40 submissions, concurrency 8, p95 ${p95.toFixed(1)} ms`);
  appendResult({
    id: 'task.local-load',
    status: 'passed',
    samples: 40,
    concurrency: 8,
    p95Ms: p95,
  });
});
