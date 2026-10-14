import {
  canTransitionDeletion,
  deletionCommandSchema,
  deletionRequestSchema,
  governanceHash,
} from '@agent-works/domain/data-governance';

import { GovernanceConflict } from '../ports/governance.js';

import { isHeld } from './holds.js';
import { purgeArtifact } from './purge.js';

import type { GovernancePort, GovernanceState } from '../ports/governance.js';
import type {
  DeletionCommand,
  DeletionRequest,
  DeletionState,
} from '@agent-works/domain/data-governance';

export type DeletionPlan = {
  requestId: string;
  artifactIds: string[];
  derivedIds: string[];
  heldIds: string[];
  actions: readonly { table: string; action: string }[];
  managedServices: 'operator evidence pending';
};
export function deletionPlan(state: GovernanceState, request: DeletionRequest): DeletionPlan {
  const artifacts = state.artifacts.filter(
    (row) => row.record.provenance.owner === request.subject,
  );
  const ids = new Set(artifacts.map((row) => row.record.id));
  return {
    requestId: request.requestId,
    artifactIds: [...ids],
    derivedIds: state.derived.filter((row) => ids.has(row.parentId)).map((row) => row.id),
    heldIds: artifacts.filter((row) => isHeld(state, row.record)).map((row) => row.record.id),
    actions: [
      { table: 'governance_artifacts', action: 'purge encrypted envelopes and provenance' },
      { table: 'governance_derived', action: 'purge index/cache/task-event/task-output envelopes' },
      { table: 'governance_tombstones', action: 'append minimal deletion evidence' },
      { table: 'governance_audit', action: 'retain immutable redaction marker' },
      {
        table: 'offline-backups',
        action: 'reapply deletion evidence before serving restored data',
      },
    ],
    managedServices: 'operator evidence pending',
  };
}
export async function requestDeletion(
  port: GovernancePort,
  input: DeletionCommand,
  actor: string,
  at: Date,
): Promise<DeletionRequest> {
  const command = deletionCommandSchema.parse(input);
  return port.transact((state) => {
    const previous = state.requests.find((row) => row.requestId === command.requestId);
    if (previous !== undefined) {
      if (
        previous.subject !== command.subject ||
        previous.reasonRef !== command.reasonRef ||
        previous.actor !== actor
      )
        throw new GovernanceConflict('deletion request reused');
      return previous;
    }
    const request = deletionRequestSchema.parse({
      ...command,
      actor,
      requestedAt: at.toISOString(),
      updatedAt: at.toISOString(),
      state: 'REQUESTED',
      rejectionRef: null,
      revision: 1,
    });
    state.requests.push(request);
    state.audit.push({
      eventId: `deletion:${command.requestId}:1`,
      type: 'deletion-request',
      occurredAt: request.requestedAt,
      actorHash: governanceHash(actor),
      targetHash: governanceHash(command.subject),
      requestId: command.requestId,
      state: 'REQUESTED',
      redactionMarker: 'governance-tombstone-v1',
    });
    return request;
  });
}
function transition(
  state: GovernanceState,
  request: DeletionRequest,
  next: DeletionState,
  actor: string,
  at: Date,
): void {
  if (request.state === next) return;
  if (!canTransitionDeletion(request.state, next))
    throw new GovernanceConflict('invalid deletion transition');
  request.state = next;
  request.updatedAt = at.toISOString();
  request.revision += 1;
  state.audit.push({
    eventId: `deletion:${request.requestId}:${request.revision}`,
    type: 'deletion-state',
    occurredAt: request.updatedAt,
    actorHash: governanceHash(actor),
    targetHash: governanceHash(request.subject),
    requestId: request.requestId,
    state: next,
    redactionMarker: 'governance-tombstone-v1',
  });
}
export async function processDeletion(
  port: GovernancePort,
  requestId: string,
  actor: string,
  at: Date,
): Promise<DeletionRequest> {
  return port.transact((state) => {
    const request = state.requests.find((row) => row.requestId === requestId);
    if (request === undefined) throw new GovernanceConflict('deletion request missing');
    if (request.state === 'PURGED' || request.state === 'REJECTED') return request;
    const plan = deletionPlan(state, request);
    if (plan.heldIds.length > 0) {
      transition(state, request, 'HELD', actor, at);
      return request;
    }
    transition(state, request, 'SCHEDULED', actor, at);
    for (const artifact of [...state.artifacts]) {
      if (artifact.record.provenance.owner === request.subject)
        purgeArtifact(state, artifact, {
          reason: 'deletion',
          requestId,
          at: at.toISOString(),
          actor,
        });
    }
    transition(state, request, 'PURGED', actor, at);
    return request;
  });
}
export async function rejectDeletion(
  port: GovernancePort,
  requestId: string,
  rejectionRef: string,
  actor: string,
  at: Date,
): Promise<DeletionRequest> {
  if (rejectionRef.length === 0) throw new GovernanceConflict('rejection evidence required');
  return port.transact((state) => {
    const request = state.requests.find((row) => row.requestId === requestId);
    if (request === undefined) throw new GovernanceConflict('deletion request missing');
    if (request.state === 'REJECTED') {
      if (request.rejectionRef !== rejectionRef)
        throw new GovernanceConflict('rejection evidence changed');
      return request;
    }
    transition(state, request, 'REJECTED', actor, at);
    request.rejectionRef = rejectionRef;
    return request;
  });
}
