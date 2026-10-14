import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { KeyUnavailable } from '../ports/governance-key-provider.js';

import { encryptedEnvelopeSchema, governanceHash, governedRecordSchema } from './model.js';

import type { EncryptedEnvelope, GovernedRecord } from './model.js';
import type { KeyProvider } from '../ports/governance-key-provider.js';

/** Mutable hold state is intentionally excluded; all other metadata is authenticated. */
export function envelopeContext(record: GovernedRecord): string {
  const immutable = governedRecordSchema.parse(record);
  return governanceHash({ ...immutable, legalHold: false });
}
export async function encryptArtifact(
  keys: KeyProvider,
  record: GovernedRecord,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  if (governanceHash(plaintext) !== record.canonicalHash) throw new Error('content hash mismatch');
  return encryptPayload(keys, envelopeContext(record), plaintext);
}
export async function encryptPayload(
  keys: KeyProvider,
  context: string,
  plaintext: string,
): Promise<EncryptedEnvelope> {
  const dataKey = randomBytes(32);
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const wrapped = await keys.wrap(dataKey, context);
    return encryptedEnvelopeSchema.parse({
      version: '1',
      algorithm: 'AES-256-GCM',
      ...wrapped,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      aadHash: governanceHash(context),
    });
  } finally {
    dataKey.fill(0);
  }
}
export async function decryptPayload(
  keys: KeyProvider,
  context: string,
  input: EncryptedEnvelope,
): Promise<string> {
  let dataKey: Buffer | undefined;
  try {
    const envelope = encryptedEnvelopeSchema.parse(input);
    if (governanceHash(context) !== envelope.aadHash) throw new KeyUnavailable();
    dataKey = await keys.unwrap(envelope, context);
    const cipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(envelope.nonce, 'base64'));
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([
      cipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      cipher.final(),
    ]).toString('utf8');
  } catch {
    throw new KeyUnavailable();
  } finally {
    dataKey?.fill(0);
  }
}
export async function decryptArtifact(
  keys: KeyProvider,
  record: GovernedRecord,
  envelope: EncryptedEnvelope,
): Promise<string> {
  const plaintext = await decryptPayload(keys, envelopeContext(record), envelope);
  if (governanceHash(plaintext) !== record.canonicalHash) throw new KeyUnavailable();
  return plaintext;
}
