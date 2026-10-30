import { describe, expect, it } from 'vitest';

import { csrfOk } from './csrf.js';

const TOKEN = 'a'.repeat(64);
const origins = new Set(['http://localhost:8280']);
const base = { sessionCsrf: TOKEN, origins };

describe('csrfOk', () => {
  it('accepts a form post with the session token and an allowed origin', () => {
    expect(
      csrfOk({
        ...base,
        headers: { origin: 'http://localhost:8280' },
        presented: TOKEN,
        json: false,
      }),
    ).toBe(true);
  });

  it('accepts a referer when the origin header is absent', () => {
    expect(
      csrfOk({
        ...base,
        headers: { referer: 'http://localhost:8280/s/alpha' },
        presented: TOKEN,
        json: false,
      }),
    ).toBe(true);
  });

  it('rejects a wrong, missing or length-mismatched token without throwing', () => {
    const headers = { origin: 'http://localhost:8280' };
    expect(csrfOk({ ...base, headers, presented: 'b'.repeat(64), json: false })).toBe(false);
    expect(csrfOk({ ...base, headers, presented: undefined, json: false })).toBe(false);
    expect(csrfOk({ ...base, headers, presented: null, json: false })).toBe(false);
    expect(csrfOk({ ...base, headers, presented: 'a', json: false })).toBe(false);
    expect(csrfOk({ ...base, headers, presented: 'é'.repeat(64), json: false })).toBe(false);
  });

  it('rejects a missing or foreign origin', () => {
    expect(csrfOk({ ...base, headers: {}, presented: TOKEN, json: false })).toBe(false);
    expect(
      csrfOk({
        ...base,
        headers: { origin: 'http://evil.example' },
        presented: TOKEN,
        json: false,
      }),
    ).toBe(false);
    expect(
      csrfOk({ ...base, headers: { referer: 'not a url' }, presented: TOKEN, json: false }),
    ).toBe(false);
  });

  it('requires a JSON content type on the JSON path, so an HTML form cannot reach it', () => {
    const origin = 'http://localhost:8280';
    expect(
      csrfOk({
        ...base,
        headers: { origin, 'content-type': 'application/json; charset=utf-8' },
        presented: TOKEN,
        json: true,
      }),
    ).toBe(true);
    expect(
      csrfOk({
        ...base,
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        presented: TOKEN,
        json: true,
      }),
    ).toBe(false);
    expect(csrfOk({ ...base, headers: { origin }, presented: TOKEN, json: true })).toBe(false);
  });
});
