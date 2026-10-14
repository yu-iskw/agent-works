import {
  delegationEdgeSchema,
  delegationAuditSchema,
} from '../../../../../packages/domain/dist/delegation.js';

import type {
  DelegationEdge,
  DelegationAudit,
} from '../../../../../packages/domain/dist/delegation.js';
import type { DelegationPort } from '../delegation.js';
export function createMemoryDelegationPort(): DelegationPort {
  const edges = new Map<string, DelegationEdge>();
  const events = new Map<string, DelegationAudit>();
  return {
    create(input) {
      const edge = delegationEdgeSchema.parse(input);
      if (edge.state !== 'pending' || edge.childTaskId === edge.parentTaskId)
        throw new Error('invalid delegation edge');
      const previous = edges.get(edge.childTaskId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(edge))
        throw new Error('delegation identity conflict');
      edges.set(edge.childTaskId, edge);
      return Promise.resolve();
    },
    settle(childTaskId, state, resultDigest, verifierRef) {
      const previous = edges.get(childTaskId);
      if (previous === undefined) throw new Error('unknown delegation');
      const updated = delegationEdgeSchema.parse({ ...previous, state, resultDigest, verifierRef });
      if (state === 'verified' && (resultDigest === null || verifierRef === null))
        throw new Error('verification evidence required');
      if (previous.state !== 'pending' && JSON.stringify(previous) !== JSON.stringify(updated))
        throw new Error('delegation terminal conflict');
      edges.set(childTaskId, updated);
      return Promise.resolve();
    },
    read(childTaskId) {
      return Promise.resolve(structuredClone(edges.get(childTaskId)));
    },
    children(parentTaskId) {
      return Promise.resolve(
        structuredClone([...edges.values()].filter((row) => row.parentTaskId === parentTaskId)),
      );
    },
    audit(input) {
      const event = delegationAuditSchema.parse(input);
      const previous = events.get(event.eventId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(event))
        throw new Error('audit identity conflict');
      events.set(event.eventId, event);
      return Promise.resolve();
    },
    audits(parentTaskId) {
      return Promise.resolve(
        structuredClone([...events.values()].filter((row) => row.parentTaskId === parentTaskId)),
      );
    },
  };
}
