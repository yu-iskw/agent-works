import type {
  InferenceRecord,
  ModelRoutingAudit,
} from '../../../../packages/domain/dist/model-policy.js';
export interface ModelRoutingPort {
  /** Append before dispatch. Identity reuse is rejected unless the entire payload is equal. */
  start(record: InferenceRecord): Promise<void>;
  /** Terminal transition is compare-and-set; terminal outcomes cannot be rewritten. */
  finish(inferenceId: string, status: 'succeeded' | 'failed'): Promise<void>;
  audit(event: ModelRoutingAudit): Promise<void>;
  inferences(taskId: string): Promise<readonly InferenceRecord[]>;
  audits(taskId: string): Promise<readonly ModelRoutingAudit[]>;
}
