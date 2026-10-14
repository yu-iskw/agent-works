import { describe, expect, it, vi } from 'vitest';

import { googleIdempotency } from './google-idempotency.js';

import type { Request } from './http.js';
function request(key = 'key'): Request {
  return {
    method: 'POST',
    url: new URL('http://127.0.0.1/documents'),
    headers: { 'idempotency-key': key },
    body: Buffer.from('{}'),
  };
}
const options = { tokens: new Map() };
describe('fake Google create idempotency', () => {
  it('deduplicates a lost-response retry', () => {
    const keys = googleIdempotency();
    const lost = { ...options, lostResponses: { remaining: 1 } };
    const create = vi.fn(() => ({ status: 201, body: { id: 'doc-1' } }));
    expect(keys.create(request(), lost, 'alice', { body: 'B' }, create).status).toBe(503);
    expect(keys.create(request(), lost, 'alice', { body: 'B' }, create)).toEqual({
      status: 201,
      body: { id: 'doc-1' },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('scopes keys to user and operation', () => {
    const keys = googleIdempotency();
    const create = vi.fn(() => ({ status: 201, body: {} }));
    keys.create(request(), options, 'alice', {}, create);
    keys.create(request(), options, 'bob', {}, create);
    const other = { ...request(), url: new URL('http://127.0.0.1/drafts') };
    keys.create(other, options, 'alice', {}, create);
    expect(create).toHaveBeenCalledTimes(3);
  });
  it('rejects changed payload under the same key', () => {
    const keys = googleIdempotency();
    const create = vi.fn(() => ({ status: 201, body: {} }));
    keys.create(request(), options, 'alice', { body: 'A' }, create);
    expect(keys.create(request(), options, 'alice', { body: 'B' }, create).status).toBe(409);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not cache failed creates', () => {
    const keys = googleIdempotency();
    const create = vi.fn(() => ({ status: 403, body: {} }));
    keys.create(request(), options, 'alice', {}, create);
    keys.create(request(), options, 'alice', {}, create);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('rejects creates without a key', () => {
    const keys = googleIdempotency();
    const create = vi.fn(() => ({ status: 201, body: {} }));
    expect(keys.create(request(''), options, 'alice', {}, create).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
