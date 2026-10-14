import { describe, expect, it } from 'vitest';

import { createMeetingPrepSkill } from './meeting-prep.js';
import { taskSkillPolicy } from './task-policy.js';
import { createWorkspaceTaskSkill } from './workspace-task.js';

describe('production task admission', () => {
  it('requires Calendar and Drive for meeting prep', () => {
    const manifest = createMeetingPrepSkill().manifest;
    expect(taskSkillPolicy(manifest, ['drive'], true).sources).toBe(false);
    expect(taskSkillPolicy(manifest, ['drive', 'calendar'], true)).toEqual({
      published: true,
      tools: true,
      sources: true,
    });
  });
  it('admits workspace tasks only when enabled with declared tools and permitted sources', () => {
    const manifest = createWorkspaceTaskSkill().manifest;
    expect(taskSkillPolicy(manifest, ['calendar', 'gmail'], true)).toEqual({
      published: true,
      tools: true,
      sources: true,
    });
    expect(taskSkillPolicy(manifest, ['calendar'], false).published).toBe(false);
    expect(taskSkillPolicy({ ...manifest, tools: ['gmail.send'] }, ['gmail'], true).tools).toBe(
      false,
    );
    expect(taskSkillPolicy(manifest, ['incidents'], true).sources).toBe(false);
  });
});
