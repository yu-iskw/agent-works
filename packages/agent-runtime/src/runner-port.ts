export type SourceDocument = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly uri: string;
};

export type RunnerInput = {
  readonly beforeModelCall?: (model: string) => Promise<void>;
  /** Second hook: routing authorization runs after the suspension hook in routed adapters. */
  readonly authorizeModelCall?: (model: string) => Promise<void>;
  readonly question: string;
  readonly sources: readonly SourceDocument[];
};

export type RunnerOutput = {
  readonly answer: string;
  readonly citedSourceIds: readonly string[];
  /** Summed model usage; undefined when the model reported none (never 0). */
  readonly usage?: { readonly promptTokens: number; readonly outputTokens: number };
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
