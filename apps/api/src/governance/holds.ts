import { GovernanceConflict } from '../ports/governance.js';

import { governanceHash, holdCommandSchema, legalHoldSchema } from './model.js';

import type { GovernedRecord, HoldCommand, LegalHold } from './model.js';
import type { GovernancePort, GovernanceState } from '../ports/governance.js';

function holdApplies(target: HoldCommand['target'], record: GovernedRecord): boolean {
  switch (target.kind) {
    case 'record':
      return target.id === record.id;
    case 'owner':
      return target.id === record.provenance.owner;
    case 'source':
      return target.id === record.provenance.sourceId;
  }
}
export function isHeld(state: GovernanceState, record: GovernedRecord): boolean {
  const current = new Map<string, LegalHold>();
  for (const hold of state.holds) {
    if (holdApplies(hold.target, record)) current.set(governanceHash(hold.target), hold);
  }
  return [...current.values()].some((hold) => hold.action === 'set');
}
export async function changeLegalHold(
  port: GovernancePort,
  input: HoldCommand,
  actor: string,
  at: Date,
): Promise<LegalHold> {
  const command = holdCommandSchema.parse(input);
  return port.transact((state) => {
    const prior = state.holds.find((hold) => hold.commandId === command.commandId);
    if (prior !== undefined) {
      const previous = holdCommandSchema.parse({
        commandId: prior.commandId,
        target: prior.target,
        action: prior.action,
        reasonRef: prior.reasonRef,
      });
      if (
        governanceHash({ ...previous, actor: prior.actor }) !==
        governanceHash({ ...command, actor })
      )
        throw new GovernanceConflict('hold command reused');
      return prior;
    }
    const hold = legalHoldSchema.parse({
      ...command,
      actor,
      occurredAt: at.toISOString(),
      sequence: state.holds.length + 1,
    });
    if (
      command.action === 'set' &&
      command.target.kind === 'record' &&
      state.tombstones.some((row) => row.recordId === command.target.id)
    )
      throw new GovernanceConflict('record already purged');
    state.holds.push(hold);
    for (const artifact of state.artifacts)
      artifact.record.legalHold = isHeld(state, artifact.record);
    state.audit.push({
      eventId: `hold:${command.commandId}`,
      type: command.action === 'set' ? 'hold-set' : 'hold-release',
      occurredAt: hold.occurredAt,
      actorHash: governanceHash(actor),
      targetHash: governanceHash(command.target),
      requestId: null,
      state: null,
      redactionMarker: 'governance-tombstone-v1',
    });
    return hold;
  });
}
