import { canTransitionDeletion, governanceHash } from '@agent-works/domain/data-governance';

import { GovernanceConflict } from '../ports/governance.js';

import type { GovernanceState } from '../ports/governance.js';
import type {
  DeletionRequest,
  DeletionState,
  GovernanceAudit,
} from '@agent-works/domain/data-governance';

const missingEvidence = 'deletion transition evidence missing';

function identity(request: DeletionRequest): string {
  const { requestId, subject, reasonRef, actor, requestedAt } = request;
  return governanceHash({ requestId, subject, reasonRef, actor, requestedAt });
}

function eventFor(
  state: GovernanceState,
  request: DeletionRequest,
  revision: number,
): GovernanceAudit {
  const event = state.audit.find(
    (row) => row.eventId === `deletion:${request.requestId}:${revision}`,
  );
  if (
    event === undefined ||
    event.requestId !== request.requestId ||
    event.targetHash !== governanceHash(request.subject) ||
    event.state === null
  ) {
    throw new GovernanceConflict(missingEvidence);
  }
  return event;
}

/** Every revision needs a corresponding audit event, including intermediate
 * SCHEDULED transitions coalesced by one atomic processing transaction. Restore
 * imports must supply the entire chain rather than bypassing this invariant. */
function validateChain(state: GovernanceState, request: DeletionRequest): void {
  let prior: DeletionState = 'REQUESTED';
  let timestamp = request.requestedAt;
  // The bound prevents malformed revisions from causing unbounded validation work.
  if (request.revision > state.audit.length) throw new GovernanceConflict(missingEvidence);
  for (let revision = 1; revision <= request.revision; revision += 1) {
    const event = eventFor(state, request, revision);
    const next = event.state;
    if (next === null) throw new GovernanceConflict(missingEvidence);
    validateEvent(request, event, prior, revision);
    if (Date.parse(event.occurredAt) < Date.parse(timestamp))
      throw new GovernanceConflict('deletion clock moved backwards');
    prior = next;
    timestamp = event.occurredAt;
  }
  if (prior !== request.state || timestamp !== request.updatedAt)
    throw new GovernanceConflict('deletion summary does not match evidence');
  if ((request.state === 'REJECTED') !== (request.rejectionRef !== null))
    throw new GovernanceConflict('rejection evidence mismatch');
}

function validateEvent(
  request: DeletionRequest,
  event: GovernanceAudit,
  prior: DeletionState,
  revision: number,
): void {
  if (revision === 1) {
    if (
      event.state !== 'REQUESTED' ||
      event.type !== 'deletion-request' ||
      event.actorHash !== governanceHash(request.actor) ||
      event.occurredAt !== request.requestedAt
    ) {
      throw new GovernanceConflict('invalid initial deletion evidence');
    }
    return;
  }
  if (
    event.type !== 'deletion-state' ||
    event.state === null ||
    !canTransitionDeletion(prior, event.state)
  ) {
    throw new GovernanceConflict('invalid deletion transition evidence');
  }
}

export function validateRequestIntegrity(state: GovernanceState, previous: GovernanceState): void {
  for (const request of state.requests) validateChain(state, request);
  for (const request of previous.requests) {
    const next = state.requests.find((row) => row.requestId === request.requestId);
    if (next === undefined) throw new GovernanceConflict('request deletion forbidden');
    if (identity(next) !== identity(request))
      throw new GovernanceConflict('deletion request identity is immutable');
    if (next.revision < request.revision)
      throw new GovernanceConflict('deletion revision moved backwards');
    if (
      (request.state === 'PURGED' || request.state === 'REJECTED') &&
      governanceHash(next) !== governanceHash(request)
    ) {
      throw new GovernanceConflict('terminal deletion request is immutable');
    }
  }
}
