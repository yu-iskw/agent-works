import { describe, expect, it } from 'vitest';

import { memoryCommand } from './form.js';
import { webMemoryItem } from './test-fixtures.js';
describe('memory forms', () => {
  it('parses consent with the visible revision and notice version', () => {
    expect(
      memoryCommand('consent', new URLSearchParams({ enabled: 'true', revision: '0' })),
    ).toEqual({ enabled: true, revision: 0, noticeVersion: 'memory-v1' });
    expect(
      memoryCommand('consent', new URLSearchParams({ enabled: 'false', revision: '1' })),
    ).toEqual({ enabled: false, revision: 1, noticeVersion: 'memory-v1' });
  });
  it('parses edit and delete without transmitting a claimed owner', () => {
    const item = webMemoryItem();
    const form = new URLSearchParams({
      id: item.id,
      agent: item.agent,
      revision: '1',
      text: 'Updated',
      owner: 'bob',
    });
    expect(memoryCommand('edit', form)).toEqual({
      id: item.id,
      agent: item.agent,
      revision: 1,
      text: 'Updated',
    });
    expect(memoryCommand('delete', form)).toEqual({ id: item.id, agent: item.agent, revision: 1 });
  });
  it.each(['', 'NaN', '-1', '0', '1.5'])('rejects invalid edit revision %s', (revision) => {
    expect(() =>
      memoryCommand(
        'edit',
        new URLSearchParams({
          id: webMemoryItem().id,
          agent: 'default',
          revision,
          text: 'Updated',
        }),
      ),
    ).toThrow();
  });
  it('rejects blank and oversized edit content', () => {
    for (const text of ['', 'x'.repeat(2049)])
      expect(() =>
        memoryCommand(
          'edit',
          new URLSearchParams({ id: webMemoryItem().id, agent: 'default', revision: '1', text }),
        ),
      ).toThrow();
  });
});
