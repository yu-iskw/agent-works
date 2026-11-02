import { describe, expect, it } from 'vitest';

import { localPath, segmentHome } from './local-path.js';

describe('segmentHome', () => {
  it('builds the startup path for a plain segment id', () => {
    expect(segmentHome('alpha')).toBe('/s/alpha');
    expect(segmentHome('beta-2')).toBe('/s/beta-2');
  });

  it.each([
    'javascript:alert(1)',
    '../../evil',
    '/evil.example',
    'Alpha',
    'alpha"><img src=x onerror=alert(1)>',
    '',
  ])('falls back to the site root for %j', (segment) => {
    expect(segmentHome(segment)).toBe('/');
  });
});

describe('localPath', () => {
  it('keeps same-origin paths', () => {
    expect(localPath('/s/alpha/pages/teammates/1')).toBe('/s/alpha/pages/teammates/1');
    expect(localPath('/s/alpha/tasks?status=running')).toBe('/s/alpha/tasks?status=running');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    '//evil.example/x',
    '/\\evil.example',
    'https://evil.example/',
    'data:text/html,<script>alert(1)</script>',
    '/s/alpha"><script>',
    '',
    null,
    undefined,
  ])('falls back to the site root for %j', (value) => {
    expect(localPath(value)).toBe('/');
  });
});
