import { describe, expect, it, vi } from 'vitest';
import {
  withRequestValidation,
  validateOperationBody,
  validateResponse,
} from '../dist/validation.js';
import { submission, task, detail } from './fixtures.mjs';
const request = (body) => ({
  method: 'POST',
  path: '/v1/tasks',
  headers: { 'idempotency-key': 'fixture-key' },
  body: Buffer.from(JSON.stringify(body)),
});
describe('request validation middleware', () => {
  it('accepts current schemas and invokes the next handler once', async () => {
    const next = vi.fn(() => Promise.resolve({ status: 200, body: task }));
    expect(await withRequestValidation('submitTask', next)(request(submission))).toEqual({
      status: 200,
      body: task,
    });
    expect(next).toHaveBeenCalledOnce();
  });
  it.each(['subject', 'userId', 'agentIdentity', 'scopes'])(
    'rejects injected trusted field %s before dispatch',
    async (field) => {
      const next = vi.fn();
      expect(
        (
          await withRequestValidation(
            'submitTask',
            next,
          )(request({ ...submission, [field]: 'amplified' }))
        ).status,
      ).toBe(400);
      expect(next).not.toHaveBeenCalled();
    },
  );
  it('rejects invalid JSON, missing idempotency and changed request shapes', async () => {
    const next = vi.fn();
    const middleware = withRequestValidation('submitTask', next);
    expect((await middleware({ ...request(submission), body: Buffer.from('{') })).status).toBe(400);
    expect((await middleware({ ...request(submission), headers: {} })).status).toBe(400);
    expect((await middleware(request({ ...submission, kind: 'accepted' }))).status).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
  it('requires approval CSRF and the exact digest format', async () => {
    const next = vi.fn();
    const middleware = withRequestValidation('decideApproval', next);
    const input = {
      method: 'POST',
      path: '/v1/approvals/a:decide',
      headers: {},
      body: Buffer.from(
        JSON.stringify({
          kind: 'decide',
          decision: 'approve',
          expectedPayloadSha256: 'a'.repeat(64),
        }),
      ),
    };
    expect((await middleware(input)).status).toBe(400);
    expect(next).not.toHaveBeenCalled();
    expect(
      validateOperationBody('decideApproval', {
        kind: 'decide',
        decision: 'approve',
        expectedPayloadSha256: 'changed',
      }),
    ).toBe(false);
  });
  it('validates current response schemas', () => {
    expect(validateResponse('readTask', 200, task)).toBe(true);
    expect(validateResponse('readApproval', 200, detail)).toBe(true);
    expect(validateResponse('readTask', 200, { id: 'task-1' })).toBe(false);
  });
});

describe('generated schema boundary parity', () => {
  it.each([0, -1])('rejects a non-positive deadline %s', (deadlineSeconds) => {
    expect(
      validateOperationBody('submitTask', {
        ...submission,
        executionPolicy: { ...submission.executionPolicy, deadlineSeconds },
      }),
    ).toBe(false);
  });
  it('rejects an invalid response URI', () => {
    expect(
      validateResponse('ask', 200, {
        requestId: '11111111-1111-4111-8111-111111111111',
        answer: 'answer',
        citations: [
          {
            sourceObjectId: 's',
            title: 't',
            sourceUri: 'invalid uri',
            retrievedAt: task.createdAt,
            excerpt: 'text',
          },
        ],
      }),
    ).toBe(false);
  });
  it('accepts callback and revoke schemas on existing OAuth routes', () => {
    const body = {
      kind: 'callback',
      provider: 'google',
      state: 'a'.repeat(43),
      code: 'code',
      codeVerifier: 'a'.repeat(43),
    };
    expect(validateOperationBody('connectOAuth', body)).toBe(true);
    expect(validateOperationBody('revokeOAuth', undefined)).toBe(true);
  });
});
