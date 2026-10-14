import { describe, expect, it } from 'vitest';

import { MemoryDenied } from '../ports/user-memory.js';

import { createMemoryBankStub } from './memory-bank.js';
describe('Memory Bank gate', () => {
  it('defaults off without invoking a callback', async () => {
    let invoked = false;
    await expect(
      createMemoryBankStub().transaction(() => {
        invoked = true;
      }),
    ).rejects.toBeInstanceOf(MemoryDenied);
    expect(invoked).toBe(false);
  });
  it('remains evidence pending even when the flag is enabled', async () => {
    await expect(createMemoryBankStub(true).transaction((state) => state.items)).rejects.toThrow(
      'operator evidence pending (#107)',
    );
  });
});
