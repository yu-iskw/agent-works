import { createHash } from 'node:crypto';
import { types } from 'node:util';

import * as z from 'zod';

const MAX_DEPTH = 32;

export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export class NonCanonicalPayload extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonCanonicalPayload';
  }
}

export function canonicalPayloadSha256(value: unknown): string {
  return createHash('sha256').update(canonicalPayloadJson(value), 'utf8').digest('hex');
}

export function canonicalPayloadJson(value: unknown): string {
  return canonicalJson(value, 0);
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) {
    throw new NonCanonicalPayload('too deep');
  }
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value);
    case 'bigint':
      throw new NonCanonicalPayload('bigint');
    case 'undefined':
      throw new NonCanonicalPayload('undefined');
    case 'symbol':
    case 'function':
      throw new NonCanonicalPayload(typeof value);
    case 'object':
      return canonicalContainer(value, depth);
    default:
      throw new NonCanonicalPayload('value');
  }
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new NonCanonicalPayload('number');
  }
  return JSON.stringify(value);
}

function canonicalContainer(value: object, depth: number): string {
  if (types.isProxy(value)) {
    throw new NonCanonicalPayload('proxy');
  }
  if (Array.isArray(value)) {
    return canonicalArray(value, depth);
  }
  const tag = Object.prototype.toString.call(value);
  if (tag === '[object Map]') {
    throw new NonCanonicalPayload('map');
  }
  if (tag === '[object Set]') {
    throw new NonCanonicalPayload('set');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NonCanonicalPayload('non-plain object');
  }
  return canonicalObject(value, depth);
}

function canonicalArray(value: unknown[], depth: number): string {
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length' || isAtFunction(value, key)) {
      continue;
    }
    if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
      throw new NonCanonicalPayload(typeof key === 'string' ? 'non-index array key' : 'symbol key');
    }
    assertEnumerableData(value, key);
  }
  if (Object.keys(value).filter((key) => !isAtFunction(value, key)).length !== value.length) {
    throw new NonCanonicalPayload('undefined');
  }
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    parts.push(canonicalJson(descriptor?.value, depth + 1));
  }
  return `[${parts.join(',')}]`;
}

function isAtFunction(value: object, key: PropertyKey): boolean {
  if (key !== 'at') {
    return false;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && typeof descriptor.value === 'function';
}

function canonicalObject(value: object, depth: number): string {
  const names: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new NonCanonicalPayload('symbol key');
    }
    assertEnumerableData(value, key);
    names.push(key);
  }
  names.sort(compareUtf16);
  const parts: string[] = [];
  for (const key of names) {
    parts.push(`${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key), depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

function assertEnumerableData(value: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new NonCanonicalPayload('property');
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (key.length === 0 || key.length > 15) {
    return false;
  }
  let index = 0;
  for (let offset = 0; offset < key.length; offset += 1) {
    const code = key.charCodeAt(offset);
    const digit = code - 48;
    if (digit < 0 || digit > 9 || (offset === 0 && digit === 0 && key.length !== 1)) {
      return false;
    }
    index = index * 10 + digit;
  }
  return index < length;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}
