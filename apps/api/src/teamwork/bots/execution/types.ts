import type { AdmissionService } from '../../../admission/postgres-admission.js';
import type { GrantStore } from '../../../authority-lifecycle/store.js';
import type { Deps, Tx } from '../../context.js';
import type { AgentRegistry } from '../../mcp-task/index.js';
import type { createBotService } from '../service.js';
import type {
  BotDefinition,
  BotRunStatus,
  BotStep,
  BotStepStatus,
  SkillPackageResolver,
} from '@agent-works/domain';

export type Db = Deps['sql'] | Tx;
export type ExecutionOptions = {
  deps: Deps;
  service: ReturnType<typeof createBotService>;
  registry: AgentRegistry;
  skills: SkillPackageResolver;
  grants: GrantStore;
  admission: AdmissionService;
  pollMs?: number;
  allowLoopback?: boolean;
};
export type RunRow = {
  task_id: string;
  teammate_id: string;
  revision: number;
  digest: string;
  owner_sub: string;
  owner_email: string;
  initiated_by: string;
  execution_sub: string;
  trigger_kind: 'manual' | 'schedule' | 'event';
  trigger_ref: string | null;
  approval_mode: BotDefinition['approvals']['mode'];
  grant_id: string | null;
  cancel_requested_at?: Date | null;
  status: BotRunStatus;
  definition: BotDefinition;
  result_text: string | null;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  deadline_at: Date;
};
type External = {
  agentId: string;
  handle: string | null;
  lastStatus: string | null;
  cancel: 'not_requested' | 'requested' | 'confirmed' | 'unsupported' | 'uncertain';
};
export type StepRow = {
  task_id: string;
  step_id: string;
  kind: BotStep['kind'];
  status: BotStepStatus;
  attempt: number;
  owner_token: string | null;
  input: unknown;
  output: { text: string } | null;
  idempotency_key: string | null;
  external: External | null;
  error_code: string | null;
  terminal_reason: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  cost_history: {
    attempt: number;
    cost: { basis: 'reported'; amountMicros: number } | { basis: 'unknown' };
  }[];
  cost: { basis: 'reported'; amountMicros: number } | { basis: 'unknown' } | null;
};
export type ApprovalRow = {
  id: string;
  subject: 'bot_run' | 'bot_checkpoint';
  step_id: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'void';
  proposal: { prompt: string };
  payload_sha256: string;
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
};
export type BotJob = { id: number; task_id: string | null; ref: string; lease_token: string };
export const ADMIN_TRANSITIONS = {
  step: { failed: ['ready'], outcome_uncertain: ['succeeded', 'failed'] },
  run: { failed: ['running'], outcome_uncertain: ['failed'] },
} as const;
const MAX_OUTPUT_BYTES = 32_768;
export function boundedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text.trim() || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new Error('invalid_output');
  return text;
}
