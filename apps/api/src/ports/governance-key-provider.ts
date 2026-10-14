type WrappedDataKey = {
  readonly keyId: string;
  readonly wrappedKey: string;
  readonly wrappingNonce: string;
  readonly wrappingTag: string;
};
export interface KeyProvider {
  wrap(dataKey: Buffer, context: string): Promise<WrappedDataKey>;
  unwrap(wrapped: WrappedDataKey, context: string): Promise<Buffer>;
}
export class KeyUnavailable extends Error {
  constructor() {
    super('key unavailable');
    this.name = 'KeyUnavailable';
  }
}
