import { describe, expect, it } from 'vitest';

import { minimizeMemoryText } from './user-memory-pii.js';
describe('local PII minimization', () => {
  it.each([
    ['email alice@example.com', 'email [email]'],
    ['email ALICE+tag@EXAMPLE.CO.JP', 'email [email]'],
    ['SSN 123-45-6789', 'SSN [government-id]'],
    ['card 4111 1111 1111 1111', 'card [account-number]'],
    ['call +1 (415) 555-0123', 'call [phone]'],
    ['password=super-secret', '[credential]'],
    ['API_KEY: abc123', '[credential]'],
    ['token=private-value', '[credential]'],
    ['Prefer concise answers', 'Prefer concise answers'],
    ['  spaced text  ', 'spaced text'],
    ['line\nnext', 'line next'],
    ['Ａｌｉｃｅ＠ｅｘａｍｐｌｅ．ｃｏｍ', '[email]'],
  ])('scrubs %s', (text, expected) => {
    expect(minimizeMemoryText(text)).toBe(expected);
  });
  it('is idempotent', () => {
    const text = 'Email alice@example.com; token=secret';
    const scrubbed = minimizeMemoryText(text);
    expect(minimizeMemoryText(scrubbed)).toBe(scrubbed);
  });
  it('keeps ordinary preferences rather than silently discarding them', () => {
    expect(minimizeMemoryText('Use Markdown and metric units.')).toBe(
      'Use Markdown and metric units.',
    );
  });
  it('documents a conservative scrubber rather than claiming semantic PII detection', () => {
    expect(minimizeMemoryText('My favorite color is blue')).toBe('My favorite color is blue');
  });
});
