import { isHeld } from './holds.js';
import { purgeArtifact } from './purge.js';

import type { GovernancePort } from '../ports/governance.js';
import type { LocalEngine, WorkflowPlan } from '../workflow/local-engine.js';

export type SweepReport = { purged: string[]; held: string[] };
export async function sweepRetention(
  port: GovernancePort,
  at: Date,
  limit = 100,
): Promise<SweepReport> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
    throw new RangeError('invalid sweep limit');
  return port.transact((state) => {
    const expired = state.artifacts
      .filter((row) => Date.parse(row.record.expiresAt) <= at.getTime())
      .sort(
        (a, b) =>
          a.record.expiresAt.localeCompare(b.record.expiresAt, 'en') ||
          a.record.id.localeCompare(b.record.id, 'en'),
      );
    const report: SweepReport = { purged: [], held: [] };
    for (const artifact of expired) {
      if (isHeld(state, artifact.record)) {
        report.held.push(artifact.record.id);
        continue;
      }
      if (report.purged.length >= limit) break;
      if (
        purgeArtifact(state, artifact, {
          reason: 'retention',
          requestId: null,
          at: at.toISOString(),
          actor: 'system:retention',
        })
      )
        report.purged.push(artifact.record.id);
    }
    return report;
  });
}
/** Caller creates a new maintenance task per sweep, using the existing local engine.
 * Receipts contain counts, not identifiers or source data. Retried steps are idempotent. */
export function retentionSweepPlan(
  port: GovernancePort,
  taskId: string,
  now: () => Date,
): WorkflowPlan {
  return {
    taskId,
    subject: 'system:retention',
    steps: [
      {
        id: 'governance-retention',
        async run({ signal }) {
          signal.throwIfAborted();
          const report = await sweepRetention(port, now());
          return JSON.stringify({ purged: report.purged.length, held: report.held.length });
        },
      },
    ],
  };
}
export function runRetentionSweep(
  engine: LocalEngine,
  port: GovernancePort,
  taskId: string,
  now: () => Date,
): ReturnType<LocalEngine['run']> {
  return engine.run(retentionSweepPlan(port, taskId, now));
}
