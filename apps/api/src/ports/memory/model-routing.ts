import {
  inferenceRecordSchema,
  modelRoutingAuditSchema,
} from '../../../../../packages/domain/dist/model-policy.js';

import type {
  InferenceRecord,
  ModelRoutingAudit,
} from '../../../../../packages/domain/dist/model-policy.js';
import type { ModelRoutingPort } from '../model-routing.js';
export function createMemoryModelRoutingPort(): ModelRoutingPort {
  const rows = new Map<string, InferenceRecord>();
  const events = new Map<string, ModelRoutingAudit>();
  return {
    start(input) {
      const record = inferenceRecordSchema.parse(input);
      if (record.status !== 'started') throw new Error('inference must start');
      const previous = rows.get(record.inferenceId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error('inference identity conflict');
      rows.set(record.inferenceId, record);
      return Promise.resolve();
    },
    finish(inferenceId, status) {
      const previous = rows.get(inferenceId);
      if (previous === undefined) throw new Error('unknown inference');
      if (previous.status !== status && previous.status !== 'started')
        throw new Error('inference terminal conflict');
      rows.set(inferenceId, { ...previous, status });
      return Promise.resolve();
    },
    audit(input) {
      const event = modelRoutingAuditSchema.parse(input);
      const previous = events.get(event.eventId);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(event))
        throw new Error('audit identity conflict');
      events.set(event.eventId, event);
      return Promise.resolve();
    },
    inferences(taskId) {
      return Promise.resolve(
        structuredClone([...rows.values()].filter((row) => row.taskId === taskId)),
      );
    },
    audits(taskId) {
      return Promise.resolve(
        structuredClone([...events.values()].filter((row) => row.taskId === taskId)),
      );
    },
  };
}
