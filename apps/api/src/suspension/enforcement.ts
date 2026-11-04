import { randomUUID } from 'node:crypto';

import { RunnerError } from '@agent-works/agent-runtime/port';
import { canonicalPayloadSha256, suspensionSnapshotSchema } from '@agent-works/domain';
import { suspensionDecision, suspensionFacts } from '@agent-works/policy';

import { noopTelemetry } from '../telemetry/instrument.js';

import type { SuspensionAudit, SuspensionLedger } from '../ports/suspension-ledger.js';
import type { Telemetry } from '../telemetry/instrument.js';
import type { InvocationContext, SuspensionDenial } from '@agent-works/policy';

export class InvocationStopped extends RunnerError {
  constructor(readonly code: SuspensionDenial) {
    super(code);
    this.name = 'InvocationStopped';
  }
}
type CheckKind = 'model' | 'tool' | 'admission';
export type SuspensionEnforcer = {
  check(context: InvocationContext, kind: CheckKind): Promise<void>;
};
export function createSuspensionEnforcer(options: {
  readonly ledger: SuspensionLedger;
  readonly now?: () => Date;
  readonly emergencyAudit?: (event: SuspensionAudit) => Promise<void>;
  readonly telemetry?: Telemetry;
}): SuspensionEnforcer {
  const now = options.now ?? (() => new Date());
  const telemetry = options.telemetry ?? noopTelemetry;
  async function decide(context: InvocationContext, kind: CheckKind): Promise<void> {
    let code: SuspensionDenial | undefined;
    try {
      const snapshot = suspensionSnapshotSchema.parse(await options.ledger.snapshot());
      code = suspensionDecision(
        suspensionFacts(context, snapshot.suspensions, snapshot.versions, now()),
      );
    } catch {
      code = 'SUSPENSION_STORE_UNAVAILABLE';
    }
    if (code === undefined) return;
    const event: SuspensionAudit = {
      eventId: randomUUID(),
      eventType: 'invocation.denied',
      actorSub: context.subject,
      occurredAt: now().toISOString(),
      reason: code,
      digest: canonicalPayloadSha256({ context, kind, code }),
      taskId: context.taskId,
      traceId: context.traceId,
      details: { context, kind, code },
    };
    try {
      await options.ledger.deny(event);
    } catch {
      try {
        await options.emergencyAudit?.(event);
      } catch {
        /* Both audit transports are unavailable; never allow the invocation. */
      }
    }
    throw new InvocationStopped(code);
  }
  return {
    check: (context, kind) =>
      telemetry.span(
        'suspension.decision',
        {
          correlation: { task: context.taskId, request: context.traceId, model: context.model },
          metric: {
            name: 'suspension_decisions_total',
            labels: { route: 'suspension.check', kind },
          },
        },
        async (span) => {
          try {
            await decide(context, kind);
            span.attribute('decision', 'allow');
          } catch (error) {
            span.status('denied');
            span.attribute('decision', error instanceof InvocationStopped ? error.code : 'error');
            throw error;
          }
        },
      ),
  };
}
