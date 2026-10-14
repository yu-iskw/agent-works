export class ModelRoutingDenied extends Error {
  constructor(readonly reason: string) {
    super(`model routing denied: ${reason}`);
    this.name = 'ModelRoutingDenied';
  }
}
export class RetryableModelFailure extends Error {
  constructor() {
    super('offline model unavailable');
    this.name = 'RetryableModelFailure';
  }
}
