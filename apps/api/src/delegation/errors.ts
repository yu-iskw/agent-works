export class DelegationDenied extends Error {
  constructor(readonly reason: string) {
    super(`delegation denied: ${reason}`);
    this.name = 'DelegationDenied';
  }
}
