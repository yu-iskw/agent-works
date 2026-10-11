import { createIncidentSkill } from './incident.js';

import type { RegisteredSkill } from './incident.js';
import type { SkillManifest } from '@agent-works/domain';

export type SkillRegistry = {
  list(): readonly SkillManifest[];
  get(id: string): RegisteredSkill | undefined;
};

export function createSkillRegistry(
  skills: readonly RegisteredSkill[] = [createIncidentSkill()],
): SkillRegistry {
  const registered = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  return {
    list: () => [...registered.values()].map((skill) => structuredClone(skill.manifest)),
    get: (id) => registered.get(id),
  };
}
