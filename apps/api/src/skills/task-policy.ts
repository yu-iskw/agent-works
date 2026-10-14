import { workspaceManifests } from '@agent-works/domain/workspace-tools';

import type { SkillManifest } from '@agent-works/domain';

const incidentSkillId = 'incident-analysis';

/** Admission policy for the bundled tasks; individual reads retain source checks. */
export function taskSkillPolicy(
  manifest: SkillManifest | undefined,
  sources: readonly string[],
  workspace: boolean,
) {
  if (!manifest) return { published: true, tools: true, sources: sources.includes('drive') };
  const declared = new Map([
    [incidentSkillId, ['ticket.create']],
    ['meeting-prep', ['calendar.listEvents', 'drive.search', 'docs.createDraft']],
    [
      'workspace-task',
      workspaceManifests.map((tool) => tool.metadata.name).filter((tool) => tool !== 'gmail.send'),
    ],
  ]).get(manifest.id);
  const enabled = manifest.id === incidentSkillId || workspace;
  return {
    published: enabled && declared !== undefined && manifest.state === 'PUBLISHED',
    tools: enabled && manifest.tools.every((tool) => declared?.includes(tool)),
    sources: allowedSources(manifest.id, sources),
  };
}
function allowedSources(skillId: string, sources: readonly string[]): boolean {
  switch (skillId) {
    case incidentSkillId:
      return sources.length > 0 && sources.every((source) => source === 'incidents');
    case 'meeting-prep':
      return ['drive', 'calendar'].every((source) => sources.includes(source));
    case 'workspace-task':
      return (
        sources.length > 0 &&
        sources.every((source) => ['calendar', 'gmail', 'docs'].includes(source))
      );
    default:
      return false;
  }
}
