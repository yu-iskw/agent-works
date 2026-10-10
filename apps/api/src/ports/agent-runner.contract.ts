import { runnerLimitsSchema } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import type { AgentRunnerLimits } from './agent-runner.js';

export const runnerContractLimits = runnerLimitsSchema.parse({
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

export function agentRunnerContract(create: () => AgentRunnerLimits): void {
  describe('AgentRunner limits', () => {
    it('stops on steps, then tool calls, then budget', () => {
      const runner = create();
      expect(runner.limits).toEqual(runnerContractLimits);
      expect(runner.stop({ steps: 2, toolCalls: 0, costUsd: 0 })).toBe('step_limit');
      expect(runner.stop({ steps: 1, toolCalls: 4, costUsd: 0 })).toBe('tool_limit');
      expect(runner.stop({ steps: 1, toolCalls: 0, costUsd: 1 })).toBe('budget');
      expect(runner.stop({ steps: 1, toolCalls: 0, costUsd: 0 })).toBe('ok');
    });
  });
}
