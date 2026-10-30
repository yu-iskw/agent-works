import { describe, expect, it } from 'vitest';

import { timelineItems } from './timeline-items.js';

import type { MessageView } from '@agent-works/domain/teamwork';

const msg = (id: string, at: string, role: MessageView['role'] = 'teammate'): MessageView => ({
  id,
  role,
  text: id,
  taskId: null,
  card: null,
  pending: false,
  at,
});

const NOW = new Date(2026, 9, 30, 12, 0, 0);
const today = (time: string) => new Date(`2026-10-30T${time}`).toISOString();
const yesterday = (time: string) => new Date(`2026-10-29T${time}`).toISOString();

describe('timeline items', () => {
  it('separates days and labels today and yesterday', () => {
    const items = timelineItems(
      [msg('a', yesterday('09:00:00')), msg('b', today('10:00:00'))],
      NOW,
    );
    expect(items.map((i) => (i.kind === 'day' ? i.label : i.id))).toEqual([
      'Yesterday',
      'msg:a',
      'Today',
      'msg:b',
    ]);
  });

  it('groups consecutive bubbles of one voice within five minutes, never across a day', () => {
    const items = timelineItems(
      [
        msg('a', today('10:00:00')),
        msg('b', today('10:03:00')),
        msg('c', today('10:09:00')),
        msg('d', today('10:09:30'), 'member'),
        msg('e', today('10:09:40'), 'member'),
        msg('f', today('10:09:50'), 'system'),
        msg('g', today('10:09:55'), 'system'),
      ],
      NOW,
    );
    const grouped = items.filter((i) => i.kind === 'message').map((i) => i.grouped);
    expect(grouped).toEqual([false, true, false, false, true, false, false]);
  });

  it('uses content-free ids so re-renders key on identity, not text', () => {
    const items = timelineItems([msg('a', today('10:00:00'))], NOW);
    expect(items.map((i) => i.id)).toEqual(['day:2026-10-30', 'msg:a']);
  });
});
