import type { SourceDocument } from '../retrieval/drive-port.js';

export type RunnerInput = {
  readonly question: string;
  readonly sources: readonly SourceDocument[];
};

type RunnerOutput = { readonly answer: string };

export class RunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunnerError';
  }
}

export interface AgentRunner {
  run(input: RunnerInput): Promise<RunnerOutput>;
}
