import {
  inferenceRecordSchema,
  modelRoutingAuditSchema,
} from '../../../../packages/domain/dist/model-policy.js';

import type {
  InferenceRecord,
  ModelRoutingAudit,
} from '../../../../packages/domain/dist/model-policy.js';
import type { ModelRoutingPort } from '../ports/model-routing.js';
import type postgres from 'postgres';
export function createPostgresModelRoutingPort(sql: postgres.Sql): ModelRoutingPort {
  return {
    async start(input) {
      const record = inferenceRecordSchema.parse(input);
      if (record.status !== 'started') throw new Error('inference must start');
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`inference:${record.inferenceId}`},0))`;
        const previous = await tx<
          { payload: InferenceRecord }[]
        >`select payload from model_inference_records where inference_id=${record.inferenceId}`;
        if (previous.length > 0) {
          if (JSON.stringify(previous[0].payload) !== JSON.stringify(record)) {
            // jsonb normalizes object key order, so compare parsed canonical data.
            if (
              JSON.stringify(inferenceRecordSchema.parse(previous[0].payload)) !==
              JSON.stringify(record)
            )
              throw new Error('inference identity conflict');
          }
          return;
        }
        await tx`insert into model_inference_records(inference_id,task_id,trace_id,model_id,model_version,region,governance_zone,status,payload) values(${record.inferenceId},${record.taskId},${record.traceId},${record.model.modelId},${record.model.version},${record.model.region},${record.model.governanceZone},${record.status},${tx.json(record)})`;
      });
    },
    async finish(inferenceId, status) {
      await sql.begin(async (tx) => {
        const rows = await tx<
          { payload: InferenceRecord }[]
        >`select payload from model_inference_records where inference_id=${inferenceId} for update`;
        const previous = rows.at(0)?.payload;
        if (previous === undefined) throw new Error('unknown inference');
        if (previous.status !== status && previous.status !== 'started')
          throw new Error('inference terminal conflict');
        await tx`update model_inference_records set status=${status},payload=${tx.json({ ...previous, status })} where inference_id=${inferenceId}`;
      });
    },
    async audit(input) {
      const event = modelRoutingAuditSchema.parse(input);
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`routing-audit:${event.eventId}`},0))`;
        const previous = await tx<
          { payload: ModelRoutingAudit }[]
        >`select payload from model_routing_audits where event_id=${event.eventId}`;
        if (previous.length > 0) {
          if (
            JSON.stringify(modelRoutingAuditSchema.parse(previous[0].payload)) !==
            JSON.stringify(event)
          )
            throw new Error('audit identity conflict');
          return;
        }
        await tx`insert into model_routing_audits(event_id,task_id,payload) values(${event.eventId},${event.taskId},${tx.json(event)})`;
      });
    },
    async inferences(taskId) {
      const rows = await sql<
        { payload: InferenceRecord }[]
      >`select payload from model_inference_records where task_id=${taskId} order by sequence`;
      return rows.map((row) => inferenceRecordSchema.parse(row.payload));
    },
    async audits(taskId) {
      const rows = await sql<
        { payload: ModelRoutingAudit }[]
      >`select payload from model_routing_audits where task_id=${taskId} order by sequence`;
      return rows.map((row) => modelRoutingAuditSchema.parse(row.payload));
    },
  };
}
