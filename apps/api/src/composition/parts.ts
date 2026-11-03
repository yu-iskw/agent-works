import { admissionReady } from '../admission/migration.js';
import { createOpsDashboard } from '../ops-dashboard/service.js';
import { outboxReady } from '../outbox/migration.js';
import { createCloudTasksQueue } from '../queue/cloud-tasks-adapter.js';
import { defaultRateLimits, defaultRetryConfig } from '../queue/cloud-tasks-config.js';
import { createJsonLinesSink, createTelemetry } from '../telemetry/instrument.js';
import { workerReady } from '../worker/migration.js';

import { createGoogleQueueHttpClient, createOutboxQueuePublisher } from './google-queue.js';

import type { OutboxWiring, Wiring } from './flags.js';
import type { AppRole } from '../auth/directory.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type { QueuePublisher } from '../outbox/publisher.js';
import type { QueueHttpClient } from '../queue/cloud-tasks-adapter.js';
import type { OpsDashboardRouteDeps } from '../routes/ops-dashboard.js';
import type { Telemetry } from '../telemetry/instrument.js';
import type postgres from 'postgres';

/** JSON lines on stdout, already redacted by the telemetry core. Absent when the flag is off. */
export function buildTelemetry(
  wiring: Wiring,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Telemetry | undefined {
  return wiring.telemetry ? createTelemetry(createJsonLinesSink(write)) : undefined;
}

const queueDispatchDeadlineSeconds = 600;

/** The Cloud Tasks publisher for the outbox. `client` is injectable so tests never reach the network. */
export function buildQueuePublisher(
  outbox: OutboxWiring,
  client: QueueHttpClient = createGoogleQueueHttpClient(),
): QueuePublisher {
  return createOutboxQueuePublisher(
    createCloudTasksQueue(
      {
        ...outbox.queue,
        dispatchDeadlineSeconds: queueDispatchDeadlineSeconds,
        retry: defaultRetryConfig,
        rateLimits: defaultRateLimits,
      },
      client,
    ),
  );
}

/**
 * Read-only dashboards. The dashboard reads the admission, outbox and worker tables, so their
 * migrations are applied here; the grants come from the existing directory role, never the body.
 */
export async function buildOpsDashboard(
  sql: postgres.Sql,
  deps: {
    readonly verify: VerifyAssertion;
    readonly rolesFor: (sub: string) => Promise<readonly AppRole[]>;
    readonly now: () => Date;
  },
): Promise<OpsDashboardRouteDeps> {
  await admissionReady(sql);
  await outboxReady(sql);
  await workerReady(sql);
  return {
    verify: deps.verify,
    authority: async (subject) => ({
      memberId: subject,
      ownedBotIds: [],
      adminSegmentIds: [],
      platformAdmin: (await deps.rolesFor(subject)).includes('Admin'),
    }),
    service: createOpsDashboard({ sql, now: deps.now }),
  };
}
