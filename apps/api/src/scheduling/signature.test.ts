import { createHmac, generateKeyPairSync, sign } from 'node:crypto';

import { expect, test } from 'vitest';

import { createLocalKeyRegistry } from './keys.js';
import { signedEventBytes, verifyEventSignature } from './signature.js';

import type { SignedEvent } from './signature.js';
const secret = Buffer.alloc(32, 7);
function event(): SignedEvent {
  const value = {
    triggerId: 'trigger',
    source: 'source',
    eventId: 'event',
    timestamp: '2026-10-14T10:00:00.000Z',
    keyId: 'key-1',
    body: Buffer.from('{"incidentId":"inc-1"}'),
    signature: '',
  };
  value.signature = createHmac('sha256', secret).update(signedEventBytes(value)).digest('hex');
  return value;
}
const hmacKey = {
  id: 'key-1',
  source: 'source',
  algorithm: 'HS256' as const,
  secret,
  revoked: false,
};
test('HMAC verifies the exact signed envelope', () => {
  expect(() => verifyEventSignature(event(), hmacKey)).not.toThrow();
});
test.each(['triggerId', 'source', 'eventId', 'timestamp', 'keyId', 'body'])(
  'tampering with %s fails verification',
  (field) => {
    const value = event();
    if (field === 'body') value.body = Buffer.from('{"incidentId":"different"}');
    else Object.assign(value, { [field]: 'tampered' });
    expect(() => verifyEventSignature(value, hmacKey)).toThrow();
  },
);
test.each(['', 'a', '0'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64)])(
  'malformed or wrong HMAC %# rejected',
  (signature) => {
    expect(() => verifyEventSignature({ ...event(), signature }, hmacKey)).toThrow();
  },
);
test('revoked key and cross-source keys are rejected', () => {
  expect(() => verifyEventSignature(event(), { ...hmacKey, revoked: true })).toThrow(
    'SIGNING_KEY_REJECTED',
  );
  expect(() => verifyEventSignature(event(), { ...hmacKey, source: 'other' })).toThrow(
    'SIGNING_KEY_REJECTED',
  );
});
test.each(['RS256', 'EdDSA'] as const)('%s compact JWS verifies an exact envelope', (algorithm) => {
  const pair =
    algorithm === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ed25519');
  const value = event();
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: algorithm, kid: value.keyId }),
  ).toString('base64url');
  const payload = signedEventBytes(value).toString('base64url');
  const signingInput = `${protectedHeader}.${payload}`;
  value.signature = `${signingInput}.${sign(algorithm === 'RS256' ? 'RSA-SHA256' : null, Buffer.from(signingInput), pair.privateKey).toString('base64url')}`;
  const key = {
    id: value.keyId,
    source: value.source,
    algorithm,
    publicKey: pair.publicKey,
    revoked: false,
  };
  expect(() => verifyEventSignature(value, key)).not.toThrow();
  expect(() => verifyEventSignature({ ...value, eventId: 'other' }, key)).toThrow(
    'INVALID_JWS_PAYLOAD',
  );
  expect(() =>
    verifyEventSignature({ ...value, signature: value.signature + '.extra' }, key),
  ).toThrow('INVALID_JWS');
});
test('JWS rejects alg none and algorithm confusion', () => {
  const pair = generateKeyPairSync('ed25519');
  const value = event();
  const header = Buffer.from(JSON.stringify({ alg: 'none', kid: value.keyId })).toString(
    'base64url',
  );
  value.signature = `${header}.${signedEventBytes(value).toString('base64url')}.eA`;
  expect(() =>
    verifyEventSignature(value, {
      id: 'key-1',
      source: 'source',
      algorithm: 'EdDSA',
      publicKey: pair.publicKey,
      revoked: false,
    }),
  ).toThrow('INVALID_JWS');
});
test('signed metadata cannot contain newline ambiguity', () => {
  expect(() => signedEventBytes({ ...event(), eventId: 'a\nb' })).toThrow('INVALID_EVENT_METADATA');
});
test('registry copies HMAC material and rejects short secrets', async () => {
  const registry = createLocalKeyRegistry([hmacKey]);
  const returned = await registry.get('key-1');
  if (returned?.algorithm !== 'HS256') throw new Error('key');
  returned.secret.fill(0);
  expect((await registry.get('key-1'))?.revoked).toBe(false);
  expect(() => createLocalKeyRegistry([{ ...hmacKey, secret: Buffer.alloc(8) }])).toThrow();
  registry.revoke('key-1');
  expect((await registry.get('key-1'))?.revoked).toBe(true);
});
