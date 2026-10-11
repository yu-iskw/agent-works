import { runnerLimitsSchema, runnerStop } from '@agent-works/domain';

import type { AgentRunnerLimits } from '../agent-runner.js';
import type { RunnerLimits } from '@agent-works/domain';

export function createMemoryRunnerLimits(limits: RunnerLimits): AgentRunnerLimits {
  const parsed = runnerLimitsSchema.parse(limits);
  return {
    limits: parsed,
    stop(usage) {
      return runnerStop(parsed, usage);
    },
  };
}
