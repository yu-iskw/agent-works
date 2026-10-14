import { delegationEdgeSchema, delegationAuditSchema } from '@agent-works/domain/delegation';

import { allocationFits } from './allocations.js';

import type { DelegationPort } from '../ports/delegation.js';
import type { DelegationEdge, DelegationAudit } from '@agent-works/domain/delegation';
import type postgres from 'postgres';
export function createPostgresDelegationPort(sql: postgres.Sql): DelegationPort {
  return {
    async create(input, parentShare) {
      const edge = delegationEdgeSchema.parse(input);
      if (edge.state !== 'pending' || edge.childTaskId === edge.parentTaskId)
        throw new Error('invalid delegation edge');
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`delegation:${edge.childTaskId}`},0))`;
        await tx`select pg_advisory_xact_lock(hashtextextended(${`delegation-parent:${edge.parentTaskId}`},0))`;
        const previous = await tx<
          { payload: DelegationEdge }[]
        >`select payload from delegation_edges where child_task_id=${edge.childTaskId}`;
        if (previous.length > 0) {
          if (
            JSON.stringify(delegationEdgeSchema.parse(previous[0].payload)) !== JSON.stringify(edge)
          )
            throw new Error('delegation identity conflict');
          return 'replay' as const;
        }
        const children = await tx<
          { payload: DelegationEdge }[]
        >`select payload from delegation_edges where parent_task_id=${edge.parentTaskId}`;
        if (
          !allocationFits(
            children.map((row) => delegationEdgeSchema.parse(row.payload)),
            edge.budgetShare,
            parentShare,
          )
        )
          return 'budget_share' as const;
        await tx`insert into delegation_edges(child_task_id,parent_task_id,root_task_id,trace_id,depth,delegated_authority_hash,budget_share,state,payload) values(${edge.childTaskId},${edge.parentTaskId},${edge.rootTaskId},${edge.traceId},${edge.depth},${edge.delegatedAuthorityHash},${tx.json(edge.budgetShare)},${edge.state},${tx.json(edge)})`;
        return 'created' as const;
      });
    },
    async settle(childTaskId, state, resultDigest, verifierRef) {
      await sql.begin(async (tx) => {
        const rows = await tx<
          { payload: DelegationEdge }[]
        >`select payload from delegation_edges where child_task_id=${childTaskId} for update`;
        const previous = rows.at(0)?.payload;
        if (previous === undefined) throw new Error('unknown delegation');
        const updated = delegationEdgeSchema.parse({
          ...previous,
          state,
          resultDigest,
          verifierRef,
        });
        if (state === 'verified' && (resultDigest === null || verifierRef === null))
          throw new Error('verification evidence required');
        if (
          previous.state !== 'pending' &&
          JSON.stringify(delegationEdgeSchema.parse(previous)) !== JSON.stringify(updated)
        )
          throw new Error('delegation terminal conflict');
        await tx`update delegation_edges set state=${state},payload=${tx.json(updated)} where child_task_id=${childTaskId}`;
      });
    },
    async read(childTaskId) {
      const rows = await sql<
        { payload: DelegationEdge }[]
      >`select payload from delegation_edges where child_task_id=${childTaskId}`;
      const row = rows.at(0);
      return row === undefined ? undefined : delegationEdgeSchema.parse(row.payload);
    },
    async children(parentTaskId) {
      const rows = await sql<
        { payload: DelegationEdge }[]
      >`select payload from delegation_edges where parent_task_id=${parentTaskId} order by sequence`;
      return rows.map((row) => delegationEdgeSchema.parse(row.payload));
    },
    async audit(input) {
      const event = delegationAuditSchema.parse(input);
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`delegation-audit:${event.eventId}`},0))`;
        const previous = await tx<
          { payload: DelegationAudit }[]
        >`select payload from delegation_audits where event_id=${event.eventId}`;
        if (previous.length > 0) {
          if (
            JSON.stringify(delegationAuditSchema.parse(previous[0].payload)) !==
            JSON.stringify(event)
          )
            throw new Error('audit identity conflict');
          return;
        }
        await tx`insert into delegation_audits(event_id,parent_task_id,payload) values(${event.eventId},${event.parentTaskId},${tx.json(event)})`;
      });
    },
    async audits(parentTaskId) {
      const rows = await sql<
        { payload: DelegationAudit }[]
      >`select payload from delegation_audits where parent_task_id=${parentTaskId} order by sequence`;
      return rows.map((row) => delegationAuditSchema.parse(row.payload));
    },
  };
}
