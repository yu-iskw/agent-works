import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { expect, it } from 'vitest';

import { Unavailable, Unauthenticated } from '../auth/iap.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';
import { createMemoryWorkflowPort } from '../ports/memory/workflow.js';
import { createLocalEngine } from '../workflow/local-engine.js';
import { createMemoryWorkflowLog } from '../workflow/workflow-log.js';

import { selectRoute } from './slot.js';
import { cancelTaskRoute, createCancelRoute, tasksCancelSlot } from './tasks-cancel.js';

import type { Caller, VerifyAssertion } from '../auth/iap.js';
import type { TaskSubmit } from '@agent-works/domain';

const request: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

function caller(sub: string): Caller {
  return { sub, assertion: sub } as Caller;
}

function routeFor(verify: VerifyAssertion) {
  const ledger = createMemoryLedgerPort();
  const engine = createLocalEngine({
    workflow: createMemoryWorkflowPort(),
    log: createMemoryWorkflowLog(),
    ledger,
  });
  return { ledger, route: createCancelRoute(engine, verify) };
}

it('selects the cancel route only when AW_TASKS_CANCEL=real', () => {
  expect(selectRoute(tasksCancelSlot, {})).toBe(tasksCancelSlot.stub);
  expect(selectRoute(tasksCancelSlot, { AW_TASKS_CANCEL: 'real' })).toBe(cancelTaskRoute);
});

it('rejects a cancel that is unauthenticated, unsigned, or missing an idempotency key', async () => {
  const missing = routeFor(() => Promise.reject(new Unauthenticated('missing'))).route;
  expect(
    await missing({
      method: 'POST',
      path: '/v1/tasks/task-1:cancel',
      headers: {},
      body: Buffer.alloc(0),
    }),
  ).toEqual({ status: 401, body: { error: 'unauthenticated' } });

  const unavailable = routeFor(() => Promise.reject(new Unavailable('iap'))).route;
  expect(
    await unavailable({
      method: 'POST',
      path: '/v1/tasks/task-1:cancel',
      headers: { [IAP_ASSERTION_HEADER]: 'alice' },
      body: Buffer.alloc(0),
    }),
  ).toEqual({ status: 503, body: { error: 'unavailable' } });

  const verify: VerifyAssertion = () => Promise.resolve(caller('alice'));
  const { route } = routeFor(verify);
  expect(
    await route({
      method: 'POST',
      path: '/v1/tasks/task-1:cancel',
      headers: { [IAP_ASSERTION_HEADER]: 'alice' },
      body: Buffer.alloc(0),
    }),
  ).toEqual({ status: 400, body: { error: 'invalid_request' } });
});

it('cancels the caller task and hides another subject', async () => {
  const verify: VerifyAssertion = (assertion) => Promise.resolve(caller(assertion ?? 'missing'));
  const { ledger, route } = routeFor(verify);
  const accepted = await ledger.submit('alice', request, 'idem-1');
  const path = `/v1/tasks/${accepted.taskId}:cancel`;
  const headers = { [IAP_ASSERTION_HEADER]: 'alice', 'idempotency-key': 'cancel-1' };
  expect(
    await route({
      method: 'POST',
      path,
      headers: { ...headers, [IAP_ASSERTION_HEADER]: 'bob' },
      body: Buffer.alloc(0),
    }),
  ).toEqual({ status: 404, body: { error: 'not_found' } });
  expect(await route({ method: 'POST', path, headers, body: Buffer.alloc(0) })).toEqual({
    status: 200,
    body: { taskId: accepted.taskId, status: 'CANCELLED' },
  });
  expect(await route({ method: 'POST', path, headers, body: Buffer.alloc(0) })).toEqual({
    status: 200,
    body: { taskId: accepted.taskId, status: 'CANCELLED' },
  });
});
