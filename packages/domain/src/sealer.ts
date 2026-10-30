import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Sealer = {
  seal(plaintext: string): string;
  open(sealed: string): string;
};

/**
 * Loads a service's 256-bit key from its own volume, creating it (mode 0600) on first start. The
 * key never leaves the volume, so one service can never open another's sealed values.
 */
export function loadKey(dir: string, name: string): Buffer {
  const path = join(dir, name);
  // Operator-configured key directory, never request controlled.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(path, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  return key;
}

/** AES-256-GCM with the context string as additional data, so a value sealed for one use cannot open as another. */
export function createSealer(key: Buffer, context: string): Sealer {
  if (key.length !== 32) throw new Error('sealing key must be 32 bytes');
  const aad = Buffer.from(context, 'utf8');
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return [
        'v1',
        ...[iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')),
      ].join('.');
    },
    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unsealable');
      const [, iv = '', tag = '', body = ''] = parts;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
