// Builds the domain timeline from the store: the conversation's messages, the details held for
// its linked tasks, and the names the sidebar knows. Pure, so the view just calls it.

import { timelineItems } from '@agent-works/domain/teamwork-timeline';

import { taskDetail } from './task-state.js';
import { dayOf } from './time.js';

import type { WorkspaceState } from './state.js';
import type { TaskDetail } from '@agent-works/domain/teamwork';
import type { TimelineInput, TimelineItem } from '@agent-works/domain/teamwork-timeline';

const NO_ITEMS: readonly TimelineItem[] = [];

/** The details the timeline can show right now: linked tasks whose detail has been fetched. */
function linkedDetails(state: WorkspaceState): readonly TaskDetail[] {
  const conversation = state.conversation;
  if (conversation === null) return [];
  return conversation.tasks.flatMap((task) => {
    const detail = taskDetail(state.tasks, task.id);
    return detail === null ? [] : [{ ...detail, apiVersion: 'teamwork.v1' as const }];
  });
}

function timelineInput(state: WorkspaceState, now: Date): TimelineInput | undefined {
  const conversation = state.conversation;
  if (conversation === null) return undefined;
  const teammate = state.sidebar.teammates.items.find((t) => t.id === conversation.teammateId);
  return {
    teammate: { id: conversation.teammateId, name: teammate?.name ?? 'Teammate' },
    messages: conversation.messages,
    tasks: linkedDetails(state),
    teammates: state.sidebar.teammates.items.map((t) => ({ id: t.id, name: t.name })),
    now: now.toISOString(),
    dayOf,
  };
}

export function timelineOf(state: WorkspaceState, now: Date): readonly TimelineItem[] {
  const input = timelineInput(state, now);
  return input === undefined ? NO_ITEMS : timelineItems(input);
}

/** Linked tasks whose detail is missing or older than the version the conversation reports. */
export function tasksToFetch(state: WorkspaceState): readonly string[] {
  const linked = state.conversation?.tasks ?? [];
  return linked
    .filter((task) => {
      const held = taskDetail(state.tasks, task.id);
      return held === null || held.task.version < task.version;
    })
    .map((task) => task.id);
}
