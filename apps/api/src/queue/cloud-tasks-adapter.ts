import { dispatchTransportName, serializeDispatchEnvelope } from '@agent-works/domain';

import { validateQueueConfig } from './cloud-tasks-config.js';

import type { QueueConfig } from './cloud-tasks-config.js';
import type { DispatchEnvelopeV1 } from '@agent-works/domain';

export type QueueHttpRequest = {
  readonly url: string;
  readonly body: string;
};

export type QueueHttpResponse = {
  readonly status: number;
};

/** Transport port. The production client attaches an access token for the enqueuing identity. */
export type QueueHttpClient = {
  post(request: QueueHttpRequest): Promise<QueueHttpResponse>;
};

type EnqueueResult = 'created' | 'duplicate';

export class EnqueueFailed extends Error {
  constructor(
    readonly retryable: boolean,
    readonly errorClass: string,
  ) {
    super(`enqueue failed: ${errorClass}`);
    this.name = 'EnqueueFailed';
  }
}

export type CloudTasksQueue = {
  enqueue(envelope: DispatchEnvelopeV1): Promise<EnqueueResult>;
};

export function createCloudTasksQueue(
  rawConfig: QueueConfig,
  client: QueueHttpClient,
): CloudTasksQueue {
  const config = validateQueueConfig(rawConfig);
  const parent = `projects/${config.projectId}/locations/${config.location}/queues/${config.queue}`;
  const url = `https://cloudtasks.googleapis.com/v2/${parent}/tasks`;

  return {
    async enqueue(envelope) {
      const payload = serializeDispatchEnvelope(envelope);
      const task = {
        name: `${parent}/tasks/${dispatchTransportName(envelope.dispatchId)}`,
        dispatchDeadline: `${config.dispatchDeadlineSeconds}s`,
        httpRequest: {
          url: config.workerUrl,
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(payload, 'utf8').toString('base64'),
          oidcToken: {
            serviceAccountEmail: config.oidcServiceAccountEmail,
            audience: config.workerUrl,
          },
        },
      };
      let response: QueueHttpResponse;
      try {
        response = await client.post({ url, body: JSON.stringify({ task }) });
      } catch {
        throw new EnqueueFailed(true, 'transport');
      }
      return classify(response.status);
    },
  };
}

function classify(status: number): EnqueueResult {
  if (status >= 200 && status < 300) return 'created';
  if (status === 409) return 'duplicate';
  if (status === 429 || status === 408 || status >= 500)
    throw new EnqueueFailed(true, `http-${status}`);
  throw new EnqueueFailed(false, `http-${status}`);
}
