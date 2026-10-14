import { createPublicKey } from 'node:crypto';

import type { KeyObject } from 'node:crypto';
export type SigningKey =
  | { id: string; source: string; algorithm: 'HS256'; secret: Buffer; revoked: boolean }
  | {
      id: string;
      source: string;
      algorithm: 'RS256' | 'EdDSA';
      publicKey: KeyObject;
      revoked: boolean;
    };
export interface SigningKeyRegistry {
  get(id: string): Promise<SigningKey | undefined>;
}
export function createLocalKeyRegistry(
  initial: readonly SigningKey[] = [],
): SigningKeyRegistry & { put(key: SigningKey): void; revoke(id: string): void } {
  const keys = new Map<string, SigningKey>();
  const put = (key: SigningKey) => {
    if (key.id.length === 0 || key.source.length === 0) throw new RangeError('key identity');
    if (key.algorithm === 'HS256' && key.secret.length < 32)
      throw new RangeError('HMAC key must contain at least 32 bytes');
    if (key.algorithm === 'RS256' && key.publicKey.asymmetricKeyType !== 'rsa')
      throw new RangeError('RSA key required');
    if (key.algorithm === 'EdDSA' && key.publicKey.asymmetricKeyType !== 'ed25519')
      throw new RangeError('Ed25519 key required');
    keys.set(
      key.id,
      key.algorithm === 'HS256' ? { ...key, secret: Buffer.from(key.secret) } : { ...key },
    );
  };
  initial.forEach(put);
  return {
    put,
    revoke(id) {
      const key = keys.get(id);
      if (key !== undefined) keys.set(id, { ...key, revoked: true });
    },
    get(id) {
      const key = keys.get(id);
      return Promise.resolve(
        key === undefined
          ? undefined
          : key.algorithm === 'HS256'
            ? { ...key, secret: Buffer.from(key.secret) }
            : { ...key },
      );
    },
  };
}
export function publicSigningKey(
  id: string,
  source: string,
  algorithm: 'RS256' | 'EdDSA',
  pem: string,
): SigningKey {
  return { id, source, algorithm, publicKey: createPublicKey(pem), revoked: false };
}
