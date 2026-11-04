import * as z from 'zod';

export const AGENT_TASK_CONTRACT = 'aw.task.v1';

export const approvedAgentSchema = z.strictObject({
  agentId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(200),
  protocol: z.literal('mcp'),
  contract: z.literal(AGENT_TASK_CONTRACT),
  endpoint: z.string().url(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  supports: z.strictObject({
    cancel: z.boolean(),
    lookupByIdempotencyKey: z.boolean(),
    reportsCost: z.boolean(),
  }),
  maxInputBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024),
  callTimeoutMs: z.number().int().positive().max(300_000),
  dataClassification: z.string().min(1).max(200),
});

export type ApprovedAgent = Omit<z.infer<typeof approvedAgentSchema>, 'allowedHosts'> & {
  allowedHosts: readonly string[];
};
export type AgentRegistry = {
  get(agentId: string): ApprovedAgent | undefined;
  list(): readonly ApprovedAgent[];
};

const safeCodeSchema = z.enum([
  'invalid_input',
  'idempotency_conflict',
  'task_failed',
  'task_not_ready',
  'task_not_found',
  'mcp_tool_error',
]);
export const submitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('accepted'),
    handle: z.string().min(1).max(256),
    duplicate: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('rejected'), code: safeCodeSchema }),
]);
export type SubmitOutcome =
  | { kind: 'accepted'; handle: string; duplicate: boolean }
  | { kind: 'rejected'; code: string }
  | {
      kind: 'uncertain';
      code: 'mcp_timeout' | 'mcp_unavailable' | 'mcp_invalid_response';
    };

export const statusSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('queued'), progress: z.string().max(1000).optional() }),
  z.strictObject({ state: z.literal('running'), progress: z.string().max(1000).optional() }),
  z.strictObject({ state: z.literal('succeeded') }),
  z.strictObject({ state: z.literal('failed'), code: safeCodeSchema }),
  z.strictObject({ state: z.literal('cancelled') }),
  z.strictObject({ state: z.literal('not_found') }),
]);
export type TaskStatus =
  | { state: 'queued' | 'running'; progress?: string }
  | { state: 'succeeded' }
  | { state: 'failed'; code: string }
  | { state: 'cancelled' }
  | { state: 'not_found' };
export const resultSchema = z.strictObject({
  output: z.json(),
  cost: z
    .discriminatedUnion('basis', [
      z.strictObject({
        basis: z.literal('reported'),
        amountMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        currency: z.string().regex(/^[A-Z]{3}$/),
      }),
      z.strictObject({ basis: z.literal('unknown') }),
    ])
    .optional(),
});
export type TaskResult = {
  output: unknown;
  cost: { basis: 'reported'; amountMicros: number; currency: string } | { basis: 'unknown' };
};
export const cancelSchema = z.strictObject({
  kind: z.enum(['cancelled', 'already_terminal', 'unsupported', 'uncertain']),
});
export type CancelOutcome = z.infer<typeof cancelSchema>;
export const lookupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('found'), handle: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.enum(['not_found', 'unsupported', 'uncertain']) }),
]);
export type LookupOutcome =
  | { kind: 'found'; handle: string }
  | { kind: 'not_found' }
  | { kind: 'unsupported' }
  | { kind: 'uncertain' };
export const submitInputSchema = z.strictObject({
  idempotencyKey: z.string().min(1).max(256),
  instruction: z.string().min(1),
  input: z.json(),
});
export type AgentTaskClient = {
  submit(
    input: { idempotencyKey: string; instruction: string; input: unknown },
    signal?: AbortSignal,
  ): Promise<SubmitOutcome>;
  status(handle: string, signal?: AbortSignal): Promise<TaskStatus>;
  result(handle: string, signal?: AbortSignal): Promise<TaskResult>;
  cancel(handle: string, signal?: AbortSignal): Promise<CancelOutcome>;
  lookup(idempotencyKey: string, signal?: AbortSignal): Promise<LookupOutcome>;
  close(): Promise<void>;
};

export const TASK_TOOLS = [
  { name: 'task.submit', readOnly: false },
  { name: 'task.status', readOnly: true },
  { name: 'task.result', readOnly: true },
  { name: 'task.cancel', readOnly: false },
  { name: 'task.lookup', readOnly: true },
] as const;
