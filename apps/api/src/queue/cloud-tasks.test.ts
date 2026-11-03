import { dispatchTransportName } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { EnqueueFailed, createCloudTasksQueue } from './cloud-tasks-adapter.js';
import {
  backoffSeconds,
  defaultRateLimits,
  defaultRetryConfig,
  maxDispatchDeadlineSeconds,
  validateQueueConfig,
} from './cloud-tasks-config.js';

import type {
  QueueHttpClient,
  QueueHttpRequest,
  QueueHttpResponse,
} from './cloud-tasks-adapter.js';
import type { QueueConfig } from './cloud-tasks-config.js';

const config: QueueConfig = {
  projectId: 'aw-dev',
  location: 'asia-northeast1',
  queue: 'aw-dispatch',
  workerUrl: 'https://aw-worker-abc123-an.a.run.app/internal/deliveries',
  oidcServiceAccountEmail: 'aw-dispatcher@aw-dev.iam.gserviceaccount.com',
  dispatchDeadlineSeconds: 25 * 60,
  retry: defaultRetryConfig,
  rateLimits: defaultRateLimits,
};

const envelope = {
  schemaVersion: 1 as const,
  executionId: 'a'.repeat(64),
  dispatchId: 'd-0001',
  correlationId: 'corr-1',
};

type FakeClient = QueueHttpClient & {
  readonly tasks: Map<string, { httpRequest: Record<string, unknown>; dispatchDeadline: string }>;
  readonly requests: QueueHttpRequest[];
  failNext: QueueHttpResponse | Error | undefined;
};

function fakeClient(): FakeClient {
  const fake: FakeClient = {
    tasks: new Map(),
    requests: [],
    failNext: undefined,
    post(request) {
      fake.requests.push(request);
      if (fake.failNext !== undefined) {
        const failure = fake.failNext;
        fake.failNext = undefined;
        return failure instanceof Error ? Promise.reject(failure) : Promise.resolve(failure);
      }
      const { task } = JSON.parse(request.body) as {
        task: { name: string; httpRequest: Record<string, unknown>; dispatchDeadline: string };
      };
      if (fake.tasks.has(task.name)) return Promise.resolve({ status: 409 });
      fake.tasks.set(task.name, task);
      return Promise.resolve({ status: 200 });
    },
  };
  return fake;
}

describe('Cloud Tasks enqueue', () => {
  it('creates a task with a stable name, OIDC config and a payload that is only the envelope', async () => {
    const client = fakeClient();
    const queue = createCloudTasksQueue(config, client);
    expect(await queue.enqueue(envelope)).toBe('created');

    const [name, task] = [...client.tasks.entries()][0];
    expect(name).toBe(
      `projects/aw-dev/locations/asia-northeast1/queues/aw-dispatch/tasks/${dispatchTransportName('d-0001')}`,
    );
    expect(client.requests[0]?.url).toBe(
      'https://cloudtasks.googleapis.com/v2/projects/aw-dev/locations/asia-northeast1/queues/aw-dispatch/tasks',
    );
    expect(task.dispatchDeadline).toBe('1500s');
    expect(task.httpRequest).toMatchObject({
      url: config.workerUrl,
      httpMethod: 'POST',
      oidcToken: {
        serviceAccountEmail: config.oidcServiceAccountEmail,
        audience: config.workerUrl,
      },
    });
    const body = Buffer.from(String(task.httpRequest.body), 'base64').toString('utf8');
    expect(JSON.parse(body)).toEqual(envelope);
    expect(Object.keys(task.httpRequest.headers as object)).toEqual(['Content-Type']);
  });

  it('treats a repeated publish of the same dispatchId as a duplicate, not an error', async () => {
    const client = fakeClient();
    const queue = createCloudTasksQueue(config, client);
    await queue.enqueue(envelope);
    expect(await queue.enqueue(envelope)).toBe('duplicate');
    expect(client.tasks.size).toBe(1);
  });

  it('distinct dispatch ids get distinct task names', async () => {
    const client = fakeClient();
    const queue = createCloudTasksQueue(config, client);
    await queue.enqueue(envelope);
    await queue.enqueue({ ...envelope, dispatchId: 'd-0002' });
    expect(client.tasks.size).toBe(2);
  });

  it('classifies failures: server and transport errors retry, client errors do not', async () => {
    const client = fakeClient();
    const queue = createCloudTasksQueue(config, client);
    const failure = async (next: QueueHttpResponse | Error) => {
      client.failNext = next;
      return queue.enqueue(envelope).catch((error: unknown) => error);
    };
    expect(await failure({ status: 503 })).toMatchObject({
      retryable: true,
      errorClass: 'http-503',
    });
    expect(await failure({ status: 429 })).toMatchObject({ retryable: true });
    expect(await failure(new Error('socket hang up'))).toMatchObject({
      retryable: true,
      errorClass: 'transport',
    });
    const permanent = await failure({ status: 403 });
    expect(permanent).toBeInstanceOf(EnqueueFailed);
    expect(permanent).toMatchObject({ retryable: false, errorClass: 'http-403' });
  });

  it('rejects an envelope that carries extra fields or an invalid id before any call', async () => {
    const client = fakeClient();
    const queue = createCloudTasksQueue(config, client);
    await expect(queue.enqueue({ ...envelope, prompt: 'x' } as never)).rejects.toThrow();
    await expect(queue.enqueue({ ...envelope, dispatchId: 'bad id!' })).rejects.toThrow();
    expect(client.requests).toHaveLength(0);
  });
});

describe('queue configuration', () => {
  it('rejects a deadline of 30 minutes or more, a non-https target and a bad service account', () => {
    expect(() => validateQueueConfig({ ...config, dispatchDeadlineSeconds: 1800 })).toThrow(
      /deadline/i,
    );
    expect(() =>
      validateQueueConfig({ ...config, dispatchDeadlineSeconds: maxDispatchDeadlineSeconds + 1 }),
    ).toThrow();
    expect(() => validateQueueConfig({ ...config, dispatchDeadlineSeconds: 5 })).toThrow();
    expect(() => validateQueueConfig({ ...config, workerUrl: 'http://x.example' })).toThrow(
      /https/,
    );
    expect(() =>
      validateQueueConfig({ ...config, oidcServiceAccountEmail: 'user@example.com' }),
    ).toThrow();
    expect(() =>
      validateQueueConfig({
        ...config,
        rateLimits: { ...defaultRateLimits, maxConcurrentDispatches: 0 },
      }),
    ).toThrow();
    expect(() =>
      validateQueueConfig({ ...config, retry: { ...defaultRetryConfig, maxBackoffSeconds: 1 } }),
    ).toThrow();
    expect(validateQueueConfig(config)).toBe(config);
  });

  it('backoff doubles, is capped, and jitters within the upper half of the cap', () => {
    const retry = {
      ...defaultRetryConfig,
      minBackoffSeconds: 10,
      maxBackoffSeconds: 100,
      maxDoublings: 3,
    };
    expect(backoffSeconds(retry, 1, () => 1)).toBe(10);
    expect(backoffSeconds(retry, 1, () => 0)).toBe(5);
    expect(backoffSeconds(retry, 3, () => 1)).toBe(40);
    expect(backoffSeconds(retry, 4, () => 1)).toBe(80);
    expect(backoffSeconds(retry, 50, () => 1)).toBe(80);
    expect(backoffSeconds({ ...retry, maxDoublings: 10 }, 50, () => 1)).toBe(100);
    for (let attempt = 1; attempt < 12; attempt += 1) {
      const delay = backoffSeconds(retry, attempt);
      expect(delay).toBeGreaterThanOrEqual(5);
      expect(delay).toBeLessThanOrEqual(100);
    }
  });
});
