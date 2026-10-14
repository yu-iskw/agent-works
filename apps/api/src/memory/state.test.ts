import { describe, expect, it } from 'vitest';

import { memoryFixture } from './test-fixtures.js';
describe('state invariant rollback', () => {
  it('cannot mutate an existing history revision', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await expect(
      f.store.transaction((state) => {
        state.history[0].text = 'rewrite';
      }),
    ).rejects.toThrow('append-only');
    expect((await f.store.transaction((state) => state.history))[0].text).toBe(
      'I prefer concise answers',
    );
  });
  it('cannot truncate or rewrite audit', async () => {
    const f = memoryFixture();
    await f.enable();
    await expect(
      f.store.transaction((state) => {
        state.audit = [];
      }),
    ).rejects.toThrow('immutable');
    expect(await f.store.transaction((state) => state.audit)).toHaveLength(1);
  });
  it('cannot move an item to a different owner or agent', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await expect(
      f.store.transaction((state) => {
        state.items[0].owner = 'bob';
      }),
    ).rejects.toThrow();
    await expect(
      f.store.transaction((state) => {
        state.items[0].agent = 'other';
      }),
    ).rejects.toThrow();
    expect((await f.store.transaction((state) => state.items))[0].owner).toBe('alice');
  });
  it('cannot remove history without physical purge evidence', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await expect(
      f.store.transaction((state) => {
        state.history = [];
      }),
    ).rejects.toThrow();
    expect(await f.store.transaction((state) => state.history)).toHaveLength(1);
  });
  it('cannot create an orphan history row', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await expect(
      f.store.transaction((state) => {
        state.items = [];
      }),
    ).rejects.toThrow('orphan');
    expect(await f.store.transaction((state) => state.items)).toHaveLength(1);
  });
  it('cannot lower the active revision or silently change provenance', async () => {
    const f = memoryFixture();
    await f.enable();
    await f.put();
    await expect(
      f.store.transaction((state) => {
        state.items[0].origin.taskId = 'different';
      }),
    ).rejects.toThrow('authority');
    expect((await f.store.transaction((state) => state.items))[0].origin.taskId).toBe('task-alice');
  });
});
