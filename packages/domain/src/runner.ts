import * as z from 'zod';

const count = z.number().int().nonnegative();

export const runnerLimitsSchema = z.strictObject({
  maxSteps: z.number().int().positive(),
  maxToolCalls: count,
  maxCostUsd: z.number().nonnegative(),
  maxElapsedMs: z.number().int().positive(),
  maxBytesRetrieved: count,
  maxGeneratedOutputs: count,
  maxModelRetries: count,
  maxSubagents: count,
  maxParallelToolCalls: z.number().int().positive(),
});

export type RunnerLimits = z.infer<typeof runnerLimitsSchema>;

export type RunnerUsage = {
  readonly steps: number;
  readonly toolCalls: number;
  readonly costUsd: number;
};

export type RunnerStop = 'ok' | 'step_limit' | 'tool_limit' | 'budget';

export function runnerStop(limits: RunnerLimits, usage: RunnerUsage): RunnerStop {
  if (usage.steps >= limits.maxSteps) return 'step_limit';
  if (usage.toolCalls >= limits.maxToolCalls) return 'tool_limit';
  if (usage.costUsd >= limits.maxCostUsd) return 'budget';
  return 'ok';
}
