import * as z from 'zod';

export const botRunStatusSchema = z.enum([
  'queued',
  'waiting_approval',
  'running',
  'waiting_external',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'outcome_uncertain',
]);
export type BotRunStatus = z.infer<typeof botRunStatusSchema>;
export const botStepStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'waiting_external',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
  'outcome_uncertain',
  'blocked',
]);
export type BotStepStatus = z.infer<typeof botStepStatusSchema>;
export const BOT_RUN_TRANSITIONS: Readonly<Record<BotRunStatus, readonly BotRunStatus[]>> = {
  queued: ['waiting_approval', 'running', 'failed', 'cancel_requested', 'cancelled'],
  waiting_approval: ['running', 'failed', 'cancel_requested', 'cancelled'],
  running: [
    'waiting_approval',
    'waiting_external',
    'completed',
    'failed',
    'cancel_requested',
    'outcome_uncertain',
  ],
  waiting_external: ['running', 'failed', 'cancel_requested', 'outcome_uncertain'],
  cancel_requested: ['cancelled', 'outcome_uncertain'],
  completed: [],
  failed: [],
  cancelled: [],
  outcome_uncertain: [],
};
export const BOT_STEP_TRANSITIONS: Readonly<Record<BotStepStatus, readonly BotStepStatus[]>> = {
  pending: ['ready', 'cancelled', 'blocked'],
  ready: ['running', 'waiting_approval', 'cancelled', 'blocked'],
  running: [
    'waiting_external',
    'waiting_approval',
    'succeeded',
    'failed',
    'cancelled',
    'outcome_uncertain',
  ],
  waiting_external: ['running', 'succeeded', 'failed', 'cancelled', 'outcome_uncertain'],
  waiting_approval: ['ready', 'running', 'failed', 'cancelled', 'blocked'],
  succeeded: [],
  failed: [],
  cancelled: [],
  outcome_uncertain: [],
  blocked: [],
};
export const BOT_RUN_TERMINAL: ReadonlySet<BotRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'outcome_uncertain',
]);
export const BOT_STEP_TERMINAL: ReadonlySet<BotStepStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'outcome_uncertain',
  'blocked',
]);
export function canTransition(kind: 'run', from: BotRunStatus, to: BotRunStatus): boolean;
export function canTransition(kind: 'step', from: BotStepStatus, to: BotStepStatus): boolean;
export function canTransition(kind: 'run' | 'step', from: string, to: string): boolean {
  const table: Readonly<Record<string, readonly string[]>> =
    kind === 'run' ? BOT_RUN_TRANSITIONS : BOT_STEP_TRANSITIONS;
  return Object.entries(table).some(([state, targets]) => state === from && targets.includes(to));
}
