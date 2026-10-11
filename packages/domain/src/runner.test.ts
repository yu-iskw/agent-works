import { describe, expect, it } from 'vitest';

import { runnerLimitsSchema, runnerStop } from './runner.js';

const limits = runnerLimitsSchema.parse({
  maxSteps: 2,
  maxToolCalls: 4,
  maxCostUsd: 1,
  maxElapsedMs: 1000,
  maxBytesRetrieved: 10,
  maxGeneratedOutputs: 1,
  maxModelRetries: 1,
  maxSubagents: 0,
  maxParallelToolCalls: 1,
});

describe('runner limits', () => {
  it('rejects a step ceiling of zero', () => {
    expect(runnerLimitsSchema.safeParse({ ...limits, maxSteps: 0 }).success).toBe(false);
  });

  it('stops on steps, then tool calls, then budget', () => {
    expect(runnerStop(limits, { steps: 2, toolCalls: 0, costUsd: 0 })).toBe('step_limit');
    expect(runnerStop(limits, { steps: 1, toolCalls: 4, costUsd: 0 })).toBe('tool_limit');
    expect(runnerStop(limits, { steps: 1, toolCalls: 0, costUsd: 1 })).toBe('budget');
    expect(runnerStop(limits, { steps: 1, toolCalls: 0, costUsd: 0 })).toBe('ok');
  });
});
