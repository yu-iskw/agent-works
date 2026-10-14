export class AnalyticsError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
    this.name = 'AnalyticsError';
  }
}
export function reject(code: string, status = 400): never {
  throw new AnalyticsError(code, status);
}
