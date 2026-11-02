import { describe, expect, it } from 'vitest';

import { chipKey, checkFile, utf8Length } from './composer.js';

describe('checkFile', () => {
  it('maps supported extensions to media types regardless of case', () => {
    expect(checkFile({ name: 'notes.MD', size: 10 }, 0)).toEqual({
      ok: true,
      mediaType: 'text/markdown',
    });
    expect(checkFile({ name: 'data.csv', size: 10 }, 0)).toEqual({
      ok: true,
      mediaType: 'text/csv',
    });
    expect(checkFile({ name: 'a.json', size: 10 }, 0)).toEqual({
      ok: true,
      mediaType: 'application/json',
    });
    expect(checkFile({ name: 'a.txt', size: 10 }, 0)).toEqual({
      ok: true,
      mediaType: 'text/plain',
    });
  });

  it('names the unsupported type and the alternatives', () => {
    expect(checkFile({ name: 'report.pdf', size: 10 }, 0)).toEqual({
      ok: false,
      message: 'PDF is not supported yet; paste the text or upload .txt, .md, .csv or .json.',
    });
    const png = checkFile({ name: 'photo.png', size: 10 }, 0);
    expect(png.ok ? '' : png.message).toContain('.png is not supported');
    const bare = checkFile({ name: 'README', size: 10 }, 0);
    expect(bare.ok ? '' : bare.message).toContain('This file type');
  });

  it('refuses oversize files and a sixth file with the limit in the message', () => {
    expect(checkFile({ name: 'big.txt', size: 300 * 1024 }, 0)).toEqual({
      ok: false,
      message: 'big.txt is 300 KB; the limit is 200 KB per file.',
    });
    expect(checkFile({ name: 'ok.txt', size: 200 * 1024 }, 4).ok).toBe(true);
    expect(checkFile({ name: 'ok.txt', size: 1 }, 5)).toEqual({
      ok: false,
      message: 'Up to 5 files per message.',
    });
  });
});

describe('utf8Length', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('日本')).toBe(6);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('a😀é')).toBe(Buffer.byteLength('a😀é', 'utf8'));
  });
});

describe('chipKey', () => {
  it('is unique per chip identity', () => {
    expect(chipKey({ kind: 'teammate', id: 'x', name: 'n', role: 'r' })).toBe('teammate:x');
    expect(chipKey({ kind: 'source', source: 'member_file', name: 'Files' })).toBe(
      'source:member_file',
    );
    expect(chipKey({ kind: 'skill', id: 's', name: 'n' })).toBe('skill:s');
  });
});
