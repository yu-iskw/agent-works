import { describe, expect, it } from 'vitest';

import { classificationFloor, maskRows } from './classification.js';
describe('governance redaction reuse', () => {
  it('masks RESTRICTED values regardless of aliases or value type', () => {
    expect(
      maskRows(
        [
          { safe: 'east', alias: 'secret' },
          { safe: null, alias: 42 },
        ],
        { safe: 'INTERNAL', alias: 'RESTRICTED' },
      ),
    ).toEqual([
      { safe: 'east', alias: '[RESTRICTED]' },
      { safe: null, alias: '[RESTRICTED]' },
    ]);
  });
  it('drops unexpected engine fields', () => {
    expect(maskRows([{ region: 'east', secret: 'private' }], { region: 'INTERNAL' })).toEqual([
      { region: 'east' },
    ]);
  });
  it('uses null for omitted allowlisted columns', () =>
    expect(maskRows([{}], { region: 'INTERNAL' })).toEqual([{ region: null }]));
  it('never lowers a classification floor', () => {
    expect(classificationFloor('RESTRICTED', 'PUBLIC')).toBe('RESTRICTED');
    expect(classificationFloor('INTERNAL', 'CONFIDENTIAL')).toBe('CONFIDENTIAL');
  });
});

describe('provider output validation', () => {
  it.each([Infinity, NaN, -Infinity])('rejects nonfinite value %s', (value) => {
    expect(() => maskRows([{ value }], { value: 'PUBLIC' })).toThrow('ENGINE_RESULT');
  });
  it('rejects an excessive unmasked scalar value', () => {
    expect(() => maskRows([{ value: 'x'.repeat(1025) }], { value: 'INTERNAL' })).toThrow(
      'ENGINE_RESULT',
    );
  });
  it('masks excessive restricted values before scalar validation', () => {
    expect(maskRows([{ value: 'x'.repeat(1025) }], { value: 'RESTRICTED' })).toEqual([
      { value: '[RESTRICTED]' },
    ]);
  });
  it('returns fresh records without mutating engine output', () => {
    const source = [{ value: 'secret' }];
    const masked = maskRows(source, { value: 'RESTRICTED' });
    Object.assign(masked[0], { value: 'changed' });
    expect(source).toEqual([{ value: 'secret' }]);
    expect(maskRows(source, { value: 'RESTRICTED' })).toEqual([{ value: '[RESTRICTED]' }]);
  });
});
