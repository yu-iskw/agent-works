import { webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { requestId } from './request-id.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('requestId', () => {
  it('produces a version 4 UUID the segment API accepts', () => {
    const fill = (bytes: Uint8Array) => webcrypto.getRandomValues(bytes);
    const ids = new Set(Array.from({ length: 200 }, () => requestId(fill)));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('sets the version and variant bits whatever the random bytes are', () => {
    expect(requestId((bytes) => bytes.fill(0xff))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(requestId((bytes) => bytes.fill(0))).toBe('00000000-0000-4000-8000-000000000000');
  });
});
