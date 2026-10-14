export type ErrorClass = 'transient' | 'permanent' | 'policy';
export type ErrorCode =
  | 'unavailable'
  | 'rate_limited'
  | 'deadline'
  | 'invalid_request'
  | 'forbidden'
  | 'budget_exceeded'
  | 'unknown';

/** Messages and provider payloads are deliberately excluded from this contract. */
export class ClassifiedError extends Error {
  constructor(
    readonly classification: ErrorClass,
    readonly code: ErrorCode,
  ) {
    super(code);
    this.name = 'ClassifiedError';
  }
}

/** Unknown errors fail closed. Adapters must explicitly classify safe transient failures. */
export function classifyError(error: unknown): ErrorClass {
  return error instanceof ClassifiedError ? error.classification : 'permanent';
}

export function classifyHttpStatus(status: number): ClassifiedError {
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new RangeError('status');
  if (status === 429) return new ClassifiedError('transient', 'rate_limited');
  if (status === 408 || status === 502 || status === 503 || status === 504)
    return new ClassifiedError('transient', 'unavailable');
  if (status === 401 || status === 403) return new ClassifiedError('policy', 'forbidden');
  return new ClassifiedError('permanent', 'invalid_request');
}
