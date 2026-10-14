import type { SourceDocument } from '../retrieval/drive-port.js';

export type RunnerInput = {
  readonly beforeModelCall?: (model: string) => Promise<void>;
  readonly question: string;
  readonly sources: readonly SourceDocument[];
};

export type RunnerOutput = {
  readonly answer: string;
  readonly citedSourceIds: readonly string[];
};

export class RunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunnerError';
  }
}

export interface AgentRunner {
  run(input: RunnerInput): Promise<RunnerOutput>;
}
