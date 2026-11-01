import { describe, expect, it } from 'vitest';

import {
  commandGroups,
  flatten,
  menuTrigger,
  mentionGroups,
  moveActive,
  plusGroups,
  removeTrigger,
} from './composer-menu.js';

import type { ComposerContext, TargetTask } from '../../../shared/composer.js';

const T1 = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';
const S1 = '33333333-2222-4333-8444-555555555555';

const context: ComposerContext = {
  segment: 'alpha',
  teammates: [
    {
      id: T1,
      name: 'Haru',
      role: 'Research',
      appearance: { avatar: null, accent: null },
      templateName: 'Researcher',
      skills: [{ id: S1, name: 'Research brief' }],
      capabilities: [],
    },
    {
      id: T2,
      name: 'Mika',
      role: 'Metrics',
      appearance: { avatar: 'sun', accent: 'amber' },
      templateName: 'Analyst',
      skills: [],
      capabilities: [],
    },
  ],
  skills: [
    {
      id: S1,
      name: 'Research brief',
      summary: 'Compare sources',
      workflows: ['research_brief'],
      attachedTo: [T1],
      synthesizes: true,
    },
  ],
  sources: [
    {
      kind: 'drive_research',
      name: 'Drive research folder',
      capability: 'drive.read',
      workflows: ['research_brief'],
      unavailable: 'Needs Google Drive — not available in this segment',
    },
    {
      kind: 'member_file',
      name: 'Files you attached',
      capability: 'files.read',
      workflows: ['research_brief', 'metrics_explanation', 'engineering_proposal'],
      unavailable: null,
    },
  ],
  repositories: [],
  issue: null,
};

const task = (extra: Partial<TargetTask>): TargetTask => ({
  taskId: 'task-1',
  title: 'Tool comparison',
  status: 'running',
  version: 1,
  latestRevision: 0,
  openQuestions: [],
  ...extra,
});

describe('menuTrigger', () => {
  it('opens @ at a word boundary with the query typed so far', () => {
    expect(menuTrigger('ask @ha', 7)).toEqual({ kind: 'mention', anchor: 4, query: 'ha' });
    expect(menuTrigger('@', 1)).toEqual({ kind: 'mention', anchor: 0, query: '' });
  });

  it('ignores @ inside a word or an email', () => {
    expect(menuTrigger('mail alice@local', 16)).toBeNull();
  });

  it('closes once the query holds whitespace', () => {
    expect(menuTrigger('@haru please', 12)).toBeNull();
  });

  it('opens / only at a line start', () => {
    expect(menuTrigger('/ta', 3)).toEqual({ kind: 'command', anchor: 0, query: 'ta' });
    expect(menuTrigger('first\n/re', 9)).toEqual({ kind: 'command', anchor: 6, query: 're' });
    expect(menuTrigger('a /task', 7)).toBeNull();
  });

  it('removes the trigger run on pick and puts the caret where it was', () => {
    const trigger = menuTrigger('ask @ha now', 7);
    expect(trigger).not.toBeNull();
    if (trigger !== null)
      expect(removeTrigger('ask @ha now', trigger)).toEqual({ text: 'ask  now', caret: 4 });
  });
});

describe('plus menu', () => {
  it('lists only real actions and disables them all when read-only', () => {
    const items = flatten(plusGroups({ readOnly: false }));
    expect(items.map((i) => i.action.kind)).toEqual([
      'attach-file',
      'add-source',
      'create-task',
      'ask-plan',
    ]);
    expect(items.every((i) => i.disabled === null)).toBe(true);
    expect(flatten(plusGroups({ readOnly: true })).every((i) => i.disabled !== null)).toBe(true);
  });
});

describe('mention menu', () => {
  it('groups teammates and sources, filters by query, and carries the disabled reason', () => {
    const groups = mentionGroups(context, 'ha', []);
    expect(groups.map((g) => g.label)).toEqual(['Teammates', 'Sources']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Haru']);
    expect(groups[1].items).toHaveLength(0);
    const all = mentionGroups(context, '', []);
    const drive = all[1].items.find((i) => i.label === 'Drive research folder');
    expect(drive?.disabled).toBe('Needs Google Drive — not available in this segment');
  });

  it('matches roles and hides what is already a chip', () => {
    const byRole = flatten(mentionGroups(context, 'metr', []));
    expect(byRole.map((i) => i.label)).toEqual(['Mika']);
    const chips = [{ kind: 'teammate' as const, id: T2, name: 'Mika', role: 'Metrics' }];
    expect(flatten(mentionGroups(context, 'metr', chips))).toHaveLength(0);
  });

  it('is empty without a context', () => {
    expect(flatten(mentionGroups(null, '', []))).toHaveLength(0);
  });
});

describe('command menu', () => {
  it('lists the current teammate skills and only the commands with a target', () => {
    const none = flatten(commandGroups(context, '', { currentTeammateId: T1, targets: [] }, []));
    expect(none.map((i) => i.label)).toEqual(['Research brief', '/task', '/plan']);
    const withQuestion = flatten(
      commandGroups(
        context,
        '',
        {
          currentTeammateId: T2,
          targets: [
            task({
              openQuestions: [{ assignmentId: 'a1', teammateName: 'Haru', question: 'Which?' }],
            }),
          ],
        },
        [],
      ),
    );
    expect(withQuestion.map((i) => i.label)).toEqual(['/task', '/plan', '/answer', '/ask']);
    const withResult = flatten(
      commandGroups(
        context,
        'rev',
        { currentTeammateId: T1, targets: [task({ latestRevision: 2, status: 'ready' })] },
        [],
      ),
    );
    expect(withResult.map((i) => i.label)).toEqual(['/revise']);
  });
});

describe('moveActive', () => {
  it('wraps with arrows and jumps with Home and End', () => {
    expect(moveActive(3, -1, 'ArrowDown')).toBe(0);
    expect(moveActive(3, 2, 'ArrowDown')).toBe(0);
    expect(moveActive(3, 0, 'ArrowUp')).toBe(2);
    expect(moveActive(3, 1, 'Home')).toBe(0);
    expect(moveActive(3, 0, 'End')).toBe(2);
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1);
  });
});
