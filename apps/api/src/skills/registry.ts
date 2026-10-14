import { createAnalystSkill } from './analyst.js';
import { createIncidentSkill } from './incident.js';
import { createMeetingPrepSkill } from './meeting-prep.js';
import { createWorkspaceTaskSkill } from './workspace-task.js';

import type { IncidentApprovalDeps, RegisteredSkill } from './incident.js';
import type { SkillManifest } from '@agent-works/domain';

export type SkillRegistry = {
  configureApprovals?(deps: IncidentApprovalDeps): void;
  list(): readonly SkillManifest[];
  get(id: string): RegisteredSkill | undefined;
};

export function createSkillRegistry(
  skills: readonly RegisteredSkill[] = [
    createIncidentSkill(),
    createAnalystSkill(),
    createMeetingPrepSkill(),
    createWorkspaceTaskSkill(),
  ],
): SkillRegistry {
  const registered = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  return {
    configureApprovals: (deps) => {
      for (const skill of registered.values()) skill.configureApprovals?.(deps);
    },
    list: () => [...registered.values()].map((skill) => structuredClone(skill.manifest)),
    get: (id) => registered.get(id),
  };
}
