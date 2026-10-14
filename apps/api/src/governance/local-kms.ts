import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { KeyUnavailable } from '../ports/governance-key-provider.js';

import type { KeyProvider } from '../ports/governance-key-provider.js';

export type LocalKms = KeyProvider & {
  rotate(keyId: string): void;
  revoke(keyId: string): void;
};
/** Local fake only. KEKs never enter artifacts, snapshots, audit or route responses. */
export function createLocalKms(initialKeyId = 'local-key-1'): LocalKms {
  const keys = new Map<string, Buffer>();
  const revoked = new Set<string>();
  let active = initialKeyId;
  keys.set(active, randomBytes(32));
  function key(id: string): Buffer {
    const found = keys.get(id);
    if (found === undefined || revoked.has(id)) throw new KeyUnavailable();
    return found;
  }
  return {
    rotate(id) {
      if (keys.has(id) || revoked.has(id) || id.length === 0) throw new KeyUnavailable();
      keys.set(id, randomBytes(32));
      active = id;
    },
    revoke(id) {
      const material = keys.get(id);
      material?.fill(0);
      keys.delete(id);
      revoked.add(id);
    },
    wrap(dataKey, context) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key(active), nonce);
      cipher.setAAD(Buffer.from(context));
      const encrypted = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return Promise.resolve({
        keyId: active,
        wrappedKey: encrypted.toString('base64'),
        wrappingNonce: nonce.toString('base64'),
        wrappingTag: cipher.getAuthTag().toString('base64'),
      });
    },
    unwrap(wrapped, context) {
      try {
        const cipher = createDecipheriv(
          'aes-256-gcm',
          key(wrapped.keyId),
          Buffer.from(wrapped.wrappingNonce, 'base64'),
        );
        cipher.setAAD(Buffer.from(context));
        cipher.setAuthTag(Buffer.from(wrapped.wrappingTag, 'base64'));
        return Promise.resolve(
          Buffer.concat([cipher.update(Buffer.from(wrapped.wrappedKey, 'base64')), cipher.final()]),
        );
      } catch {
        return Promise.reject(new KeyUnavailable());
      }
    },
  };
}
