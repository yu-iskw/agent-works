import { describe, expect, it } from 'vitest';

import {
  canonicalPayloadJson,
  canonicalPayloadSha256,
  NonCanonicalPayload,
} from './canonical-hash.js';

describe('canonicalPayloadSha256', () => {
  it('key-order-stable', () => {
    const left = canonicalPayloadSha256({ b: 1, a: { d: true, c: 'x' } });
    const right = canonicalPayloadSha256({ a: { c: 'x', d: true }, b: 1 });
    expect(left).toBe(right);
    expect(left).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects-map', () => {
    expect(() => canonicalPayloadSha256(new Map([['a', 1]]))).toThrow(NonCanonicalPayload);
  });

  it('rejects-bigint', () => {
    expect(() => canonicalPayloadSha256({ n: 1n })).toThrow(NonCanonicalPayload);
  });

  it('rejects-undefined', () => {
    expect(() => canonicalPayloadSha256({ a: 1, b: undefined })).toThrow(NonCanonicalPayload);
  });

  it('recipient-change-changes-hash', () => {
    const alice = canonicalPayloadSha256({ recipient: 'a@example.com', note: 'hi' });
    const bob = canonicalPayloadSha256({ recipient: 'b@example.com', note: 'hi' });
    expect(alice).not.toBe(bob);
  });

  it('rejects a symbol key instead of dropping it', () => {
    const withSymbol = { a: 1 };
    Object.defineProperty(withSymbol, Symbol('s'), { value: 2, enumerable: true });
    expect(() => canonicalPayloadSha256(withSymbol)).toThrow(NonCanonicalPayload);
    expect(canonicalPayloadJson({ a: 1 })).toBe('{"a":1}');
  });

  it('keeps a proto key in the digest', () => {
    const withProto = Object.create(null) as Record<string, unknown>;
    withProto.__proto__ = { admin: true };
    withProto.b = 1;
    const without = { b: 1 };
    expect(canonicalPayloadSha256(withProto)).not.toBe(canonicalPayloadSha256(without));
  });

  it('reads array elements by index when the iterator is replaced', () => {
    const recipients = ['alice@example.com', 'bob@example.com'];
    const proto: object = {};
    Object.setPrototypeOf(proto, Array.prototype);
    Object.defineProperty(proto, Symbol.iterator, {
      value: function* overridden() {
        yield 'approver@example.com';
      },
    });
    Object.setPrototypeOf(recipients, proto);
    expect(canonicalPayloadJson({ recipients })).toBe(
      '{"recipients":["alice@example.com","bob@example.com"]}',
    );
  });

  it('rejects values JSON.stringify would coerce', () => {
    expect(() => canonicalPayloadSha256(Number.NaN)).toThrow(NonCanonicalPayload);
    expect(() => canonicalPayloadSha256(-0)).toThrow(NonCanonicalPayload);
    expect(() => canonicalPayloadSha256(new Set([1]))).toThrow(NonCanonicalPayload);
    const hole: unknown[] = [];
    hole[1] = 2;
    expect(() => canonicalPayloadSha256(hole)).toThrow(NonCanonicalPayload);
    expect(() => canonicalPayloadSha256(Object(1))).toThrow(NonCanonicalPayload);
    expect(() => canonicalPayloadSha256(new Uint8Array([1, 2]))).toThrow(NonCanonicalPayload);
  });
});
