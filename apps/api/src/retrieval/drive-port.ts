import type { Caller } from '../auth/iap.js';

export type SourceDocument = {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly uri: string;
};

export class RetrievalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetrievalError';
  }
}

export interface Drive {
  retrieve(caller: Caller, question: string): Promise<readonly SourceDocument[]>;
}
