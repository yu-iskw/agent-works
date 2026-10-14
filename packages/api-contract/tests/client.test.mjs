import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../dist/client.generated.js';
import { ApiClientError } from '../dist/transport.js';
import { submission, task, detail } from './fixtures.mjs';
describe('generated typed tasks and approvals client', () => {
  it('uses the encoded task path and IAP assertion', async () => {
    const load = vi.fn(() => Promise.resolve(new Response(JSON.stringify(task))));
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:8084',
      assertion: 'offline-assertion',
      fetch: load,
    });
    await client.readTask('task / ?');
    expect(String(load.mock.calls[0][0])).toBe('http://127.0.0.1:8084/v1/tasks/task%20%2F%20%3F');
    expect(load.mock.calls[0][1].headers['x-goog-iap-jwt-assertion']).toBe('offline-assertion');
    expect(load.mock.calls[0][1].redirect).toBe('error');
  });
  it('sends the exact approval decision and CSRF token', async () => {
    const load = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            kind: 'decided',
            id: 'approval-1',
            state: 'approved',
            executionsUsed: 0,
          }),
        ),
      ),
    );
    const client = new ApiClient({ baseUrl: 'https://api.fake.test', fetch: load });
    const body = {
      kind: 'decide',
      decision: 'approve',
      expectedPayloadSha256: detail.payloadSha256,
    };
    await client.decideApproval('approval-1', body, { 'x-csrf-token': 'csrf' });
    expect(JSON.parse(load.mock.calls[0][1].body)).toEqual(body);
    expect(load.mock.calls[0][1].headers['x-csrf-token']).toBe('csrf');
  });
  it('rejects malformed task requests before network dispatch', async () => {
    const load = vi.fn();
    const client = new ApiClient({ baseUrl: 'https://api.fake.test', fetch: load });
    await expect(
      client.submitTask({ ...submission, agentIdentity: 'injected' }),
    ).rejects.toBeInstanceOf(ApiClientError);
    expect(load).not.toHaveBeenCalled();
  });
  it('rejects drifted success responses', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.fake.test',
      fetch: () => Promise.resolve(new Response(JSON.stringify({ id: 'task-1' }))),
    });
    await expect(client.readTask('task-1')).rejects.toThrow('invalid_response');
  });
  it('returns safe API error families without reflecting server payloads', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.fake.test',
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'secret bearer credential text' }), { status: 403 }),
        ),
    });
    await expect(client.readApproval('approval-1')).rejects.toThrow('request_failed');
  });
  it.each([
    'http://external.fake.test',
    'https://user:secret@api.fake.test',
    'https://api.fake.test?token=secret',
  ])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => new ApiClient({ baseUrl })).toThrow();
  });
});

it('rejects missing required task headers before dispatch', async () => {
  const load = vi.fn();
  const client = new ApiClient({ baseUrl: 'https://api.fake.test', fetch: load });
  await expect(client.submitTask(submission)).rejects.toThrow('invalid_request');
  expect(load).not.toHaveBeenCalled();
});
it('submits a valid task with case-insensitive idempotency header', async () => {
  const load = vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          kind: 'accepted',
          taskId: 'task-1',
          status: 'QUEUED',
          submittedAt: task.createdAt,
          statusUrl: '/v1/tasks/task-1',
          traceId: 'trace-1',
        }),
      ),
    ),
  );
  const client = new ApiClient({ baseUrl: 'https://api.fake.test', fetch: load });
  await expect(client.submitTask(submission, { 'Idempotency-Key': 'key' })).resolves.toMatchObject({
    taskId: 'task-1',
  });
  expect(load).toHaveBeenCalledOnce();
});

it('accepts nonempty task outbox events and rejects bare audit events', async () => {
  const event = {
    eventId: 'event-1',
    eventType: 'task.queued',
    schemaVersion: '1',
    occurredAt: task.createdAt,
    taskId: task.id,
    stepId: 'step-1',
    traceId: 'trace-1',
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:test',
    tool: null,
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: null,
    outcome: 'queued',
    externalObjectRef: null,
    prevDigest: null,
  };
  const events = [
    { destination: 'audit', event },
    { destination: 'work', event },
  ];
  const load = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ events }))));
  const client = new ApiClient({ baseUrl: 'https://api.fake.test', fetch: load });
  await expect(client.taskEvents(task.id)).resolves.toEqual({ events });
  load.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ events: [event] }))));
  await expect(client.taskEvents(task.id)).rejects.toThrow('invalid_response');
});
