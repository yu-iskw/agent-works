import {
  capabilityKey,
  capabilityTransition,
  capabilityVersionCommandSchema,
  capabilityVersionHash,
  capabilityVersionSchema,
  suspensionCommandSchema,
  suspensionHash,
  suspensionKey,
  suspensionSchema,
} from '@agent-works/domain';

import { commandDigest, SuspensionConflict } from '../ports/suspension-ledger.js';

import type {
  AdminCommand,
  AdminResult,
  SuspensionAudit,
  SuspensionSnapshot,
} from '../ports/suspension-ledger.js';

export function parseAdminCommand(input: AdminCommand): AdminCommand {
  return input.kind === 'suspension'
    ? { kind: 'suspension', command: suspensionCommandSchema.parse(input.command) }
    : { kind: 'version', command: capabilityVersionCommandSchema.parse(input.command) };
}
export function prepareChange(
  input: AdminCommand,
  actorSub: string,
  at: Date,
  snapshot: SuspensionSnapshot,
): { result: AdminResult; audit: SuspensionAudit; key: string } {
  if (actorSub.trim().length === 0) throw new Error('missing actor');
  const command = input.command;
  const key =
    input.kind === 'suspension'
      ? suspensionKey(input.command.target)
      : capabilityKey(input.command.pin);
  const current =
    input.kind === 'suspension'
      ? snapshot.suspensions.find((value) => suspensionKey(value.target) === key)
      : snapshot.versions.find((value) => capabilityKey(value.pin) === key);
  if ((current?.revision ?? 0) !== command.expectedRevision) throw new SuspensionConflict();
  const revision = command.expectedRevision + 1;
  const stamp = {
    actorSub,
    occurredAt: at.toISOString(),
    revision,
    commandId: command.commandId,
    reason: command.reason,
  };
  const record = buildRecord(input, snapshot, key, at, stamp);
  const digest = 'target' in record ? suspensionHash(record) : capabilityVersionHash(record);
  const audit: SuspensionAudit = {
    eventId: command.commandId,
    eventType:
      input.kind === 'version'
        ? 'admin.version'
        : input.command.action === 'suspend'
          ? 'admin.suspend'
          : 'admin.resume',
    actorSub,
    occurredAt: at.toISOString(),
    reason: command.reason,
    digest,
    taskId: null,
    traceId: command.commandId,
    details: { command: input, record, commandDigest: commandDigest(input, actorSub) },
  };
  return { result: { record, replay: false }, audit, key };
}
function buildRecord(
  input: AdminCommand,
  snapshot: SuspensionSnapshot,
  key: string,
  at: Date,
  stamp: {
    actorSub: string;
    occurredAt: string;
    revision: number;
    commandId: string;
    reason: string;
  },
) {
  if (input.kind === 'suspension') {
    if (input.command.expiresAt !== null && Date.parse(input.command.expiresAt) <= at.getTime())
      throw new SuspensionConflict('expiry must be in the future');
    const current = snapshot.suspensions.find((value) => suspensionKey(value.target) === key);
    if (input.command.action === 'resume' && current?.suspended !== true)
      throw new SuspensionConflict('target is not suspended');
    return suspensionSchema.parse({
      ...stamp,
      target: input.command.target,
      suspended: input.command.action === 'suspend',
      expiresAt: input.command.expiresAt,
    });
  }
  const current = snapshot.versions.find((value) => capabilityKey(value.pin) === key);
  if (!capabilityTransition(current?.state, input.command.state))
    throw new SuspensionConflict('illegal capability transition');
  return capabilityVersionSchema.parse({
    ...stamp,
    pin: input.command.pin,
    state: input.command.state,
  });
}
