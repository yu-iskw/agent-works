import type { RunnerLimits, RunnerStop, RunnerUsage } from '@agent-works/domain';

export interface AgentRunnerLimits {
  readonly limits: RunnerLimits;
  stop(usage: RunnerUsage): RunnerStop;
}
