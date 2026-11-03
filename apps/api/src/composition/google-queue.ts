import { readDispatchEnvelope } from '@agent-works/domain';
import { GoogleAuth } from 'google-auth-library';

import { QueuePublishError } from '../outbox/publisher.js';
import { EnqueueFailed } from '../queue/cloud-tasks-adapter.js';

import type { QueueMessage, QueuePublisher } from '../outbox/publisher.js';
import type { CloudTasksQueue, QueueHttpClient } from '../queue/cloud-tasks-adapter.js';

const cloudPlatformScope = 'https://www.googleapis.com/auth/cloud-platform';

/** Returns a bearer token for the enqueuing identity. Injected so tests never reach the network. */
type AccessToken = () => Promise<string>;

function googleAccessToken(): AccessToken {
  const auth = new GoogleAuth({ scopes: [cloudPlatformScope] });
  return async () => {
    const token = await auth.getAccessToken();
    if (typeof token !== 'string' || token === '') throw new Error('no access token');
    return token;
  };
}

/** The Cloud Tasks `tasks.create` transport. A transport error is thrown; an HTTP status is returned. */
export function createGoogleQueueHttpClient(
  options: { readonly accessToken?: AccessToken; readonly fetch?: typeof fetch } = {},
): QueueHttpClient {
  const token = options.accessToken ?? googleAccessToken();
  const send = options.fetch ?? fetch;
  return {
    async post(request) {
      const response = await send(request.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await token()}`,
          'content-type': 'application/json',
        },
        body: request.body,
      });
      return { status: response.status };
    },
  };
}

/**
 * Adapts the SCH-03 queue to the SCH-02 outbox publisher port. The outbox hands over the already
 * serialized envelope; it is re-read through the frozen v1 reader so the queue sees exactly one
 * validated shape, and a row that no longer parses is a permanent failure, never a retry loop.
 */
export function createOutboxQueuePublisher(queue: CloudTasksQueue): QueuePublisher {
  return {
    async publish(message: QueueMessage) {
      const read = readDispatchEnvelope(message.body);
      if (!read.ok) throw new QueuePublishError('bad-envelope', read.retryable);
      try {
        return (await queue.enqueue(read.envelope)) === 'created' ? 'created' : 'exists';
      } catch (error) {
        if (error instanceof EnqueueFailed)
          throw new QueuePublishError(error.errorClass, error.retryable);
        throw new QueuePublishError('unknown', true);
      }
    },
  };
}
