import type { QueueMessage, QueuePublisher } from './publisher.js';
import type { Sql } from 'postgres';

export type QueueBehavior = 'ok' | 'ack-lost' | Error;

/**
 * In-memory queue with Cloud Tasks semantics: a stable name that already exists answers `exists`.
 * `ack-lost` accepts the message and then throws, as a timeout after the remote commit would.
 */
export function createMemoryQueue(
  behavior: (message: QueueMessage, call: number) => QueueBehavior | Promise<QueueBehavior> = () =>
    'ok',
) {
  const accepted = new Map<string, number>();
  let calls = 0;
  const queue: QueuePublisher = {
    async publish(message) {
      calls += 1;
      const outcome = await behavior(message, calls);
      if (outcome instanceof Error) throw outcome;
      const seen = accepted.get(message.transportName) ?? 0;
      accepted.set(message.transportName, seen + 1);
      if (outcome === 'ack-lost') throw new Error('deadline exceeded after remote accept');
      return seen === 0 ? 'created' : 'exists';
    },
  };
  return {
    queue,
    accepted,
    get calls() {
      return calls;
    },
  };
}

export async function dropOutboxSchema(sql: Sql): Promise<void> {
  await sql`drop table if exists dispatch_outbox cascade`;
  await sql`drop function if exists dispatch_outbox_terminal_guard()`;
}
