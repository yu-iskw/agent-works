import { randomUUID } from 'node:crypto';

import { canonicalPayloadSha256, suspensionSnapshotSchema } from '@agent-works/domain';
import { suspensionDecision, suspensionFacts } from '@agent-works/policy';

import { RunnerError } from '../agent/runner-port.js';

import type { SuspensionAudit, SuspensionLedger } from '../ports/suspension-ledger.js';
import type { InvocationContext, SuspensionDenial } from '@agent-works/policy';

export class InvocationStopped extends RunnerError {
  constructor(readonly code: SuspensionDenial) {
    super(code);
    this.name = 'InvocationStopped';
  }
}
export type SuspensionEnforcer = {
  check(context: InvocationContext, kind: 'model' | 'tool' | 'admission'): Promise<void>;
};
export function createSuspensionEnforcer(options: {
  readonly ledger: SuspensionLedger;
  readonly now?: () => Date;
  readonly emergencyAudit?: (event: SuspensionAudit) => Promise<void>;
}): SuspensionEnforcer {
  const now = options.now ?? (() => new Date());
  return {
    async check(context, kind) {
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
    },
  };
}
