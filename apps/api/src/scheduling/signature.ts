import { createHmac, timingSafeEqual, verify } from 'node:crypto';

import * as z from 'zod';

import { ScheduleDenied } from './authority.js';

import type { SigningKey } from './keys.js';
export type SignedEvent = {
  triggerId: string;
  source: string;
  eventId: string;
  timestamp: string;
  keyId: string;
  signature: string;
  body: Buffer;
};
export function signedEventBytes(event: Omit<SignedEvent, 'signature'>): Buffer {
  const fields = [event.triggerId, event.source, event.eventId, event.timestamp, event.keyId];
  if (fields.some((v) => v.length === 0 || v.length > 256 || /[\r\n]/.test(v)))
    throw new ScheduleDenied('INVALID_EVENT_METADATA');
  return Buffer.concat([Buffer.from(`aw-event-v1\n${fields.join('\n')}\n`), event.body]);
}
export function verifyEventSignature(event: SignedEvent, key: SigningKey): void {
  if (key.revoked || key.id !== event.keyId || key.source !== event.source)
    throw new ScheduleDenied('SIGNING_KEY_REJECTED');
  const bytes = signedEventBytes(event);
  if (key.algorithm === 'HS256') {
    if (!/^[a-f0-9]{64}$/.test(event.signature)) throw new ScheduleDenied('INVALID_SIGNATURE');
    const expected = createHmac('sha256', key.secret).update(bytes).digest();
    if (!timingSafeEqual(expected, Buffer.from(event.signature, 'hex')))
      throw new ScheduleDenied('INVALID_SIGNATURE');
    return;
  }
  verifyJws(event.signature, bytes, key);
}
const protectedSchema = z.strictObject({
  alg: z.enum(['RS256', 'EdDSA']),
  kid: z.string().min(1),
  typ: z.literal('JWT').optional(),
});
function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ScheduleDenied('INVALID_JWS');
  const buffer = Buffer.from(value, 'base64url');
  if (buffer.toString('base64url') !== value) throw new ScheduleDenied('INVALID_JWS');
  return buffer;
}
function verifyJws(
  signature: string,
  bytes: Buffer,
  key: Exclude<SigningKey, { algorithm: 'HS256' }>,
): void {
  const parts = signature.split('.');
  if (parts.length !== 3) throw new ScheduleDenied('INVALID_JWS');
  let header: unknown;
  try {
    header = JSON.parse(decode(parts[0]).toString('utf8')) as unknown;
  } catch {
    throw new ScheduleDenied('INVALID_JWS');
  }
  const parsed = protectedSchema.safeParse(header);
  if (!parsed.success || parsed.data.alg !== key.algorithm || parsed.data.kid !== key.id)
    throw new ScheduleDenied('INVALID_JWS');
  const payload = decode(parts[1]);
  if (payload.length !== bytes.length || !timingSafeEqual(payload, bytes))
    throw new ScheduleDenied('INVALID_JWS_PAYLOAD');
  const valid = verify(
    key.algorithm === 'RS256' ? 'RSA-SHA256' : null,
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key.publicKey,
    decode(parts[2]),
  );
  if (!valid) throw new ScheduleDenied('INVALID_SIGNATURE');
}
