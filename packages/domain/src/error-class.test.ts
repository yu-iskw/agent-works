import { describe, expect, it } from 'vitest';

import { ClassifiedError, classifyError, classifyHttpStatus } from './error-class.js';

describe('safe taxonomy', () => {
  it.each([429, 408, 502, 503, 504])('explicitly classifies status %i as transient', (status) => {
    expect(classifyHttpStatus(status).classification).toBe('transient');
  });
  it.each([401, 403])('classifies %i as policy', (status) => {
    expect(classifyHttpStatus(status).classification).toBe('policy');
  });
  it.each([400, 404, 409, 500])('fails closed for %i', (status) => {
    expect(classifyHttpStatus(status).classification).toBe('permanent');
  });
  it('never derives retries from untrusted error strings', () => {
    expect(classifyError(new Error('retry me: 503'))).toBe('permanent');
    expect(classifyError({ classification: 'transient' })).toBe('permanent');
    expect(classifyError(new ClassifiedError('policy', 'forbidden'))).toBe('policy');
  });
  it.each([0, 600, NaN, Infinity, 400.1])('rejects malformed status %s', (status) => {
    expect(() => classifyHttpStatus(status)).toThrow(RangeError);
  });
});
