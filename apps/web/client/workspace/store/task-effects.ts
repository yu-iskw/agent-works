// Fetches task details for the timeline and panels, and posts task commands. A detail is fetched
// when a linked task first appears, when the conversation poll reports a moved version, or when a
// panel route names a task the conversation does not link; a command refetches its task.

import { effect } from '@preact/signals';

import { api as paths } from '../../../shared/contract.js';
import { ApiFailure, SegmentMismatch } from '../api.js';

import { taskOfPanel } from './panel-routes.js';
import { taskEntry } from './task-state.js';
import { tasksToFetch } from './timeline-select.js';

import type { Api } from '../api.js';
import type { Store } from './store.js';
import type { TaskCommand, TaskCommandReply, TaskDetailPage } from '../../../shared/contract.js';

export type CommandOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: string; readonly text: string };

export type TaskEffects = {
  readonly start: () => () => void;
  readonly refresh: (taskId: string) => Promise<void>;
  readonly command: (
    taskId: string,
    command: TaskCommand,
    body?: unknown,
  ) => Promise<CommandOutcome>;
};

const FAILURE_TEXT: Readonly<Partial<Record<string, string>>> = {
  stale_plan: 'This plan changed since you opened it. Reload the panel and decide again.',
  plan_not_current: 'A newer plan version replaced this one.',
  not_in_plan_review: 'The task is no longer waiting for a plan decision.',
  stale_revision: 'A newer revision exists, so this approval is void.',
  approval_expired: 'This approval expired before a decision was made.',
  reply_pending: 'Wait for the current reply before sending another follow-up.',
  csrf: 'Your session changed. Reload the page and try again.',
};

function failureOf(error: unknown): CommandOutcome {
  const code = error instanceof ApiFailure ? error.code : 'unavailable';
  // Codes are segment error strings read from a closed record.
  // eslint-disable-next-line security/detect-object-injection
  const known = FAILURE_TEXT[code];
  return { ok: false, code, text: known ?? `The segment refused this action (${code}).` };
}

export function createTaskEffects(deps: { readonly store: Store; readonly api: Api }): TaskEffects {
  const { store, api } = deps;
  const { dispatch, peek } = store;
  const segment = peek().scope.segment;
  const inFlight = new Set<string>();
  /** Linked version at the last failed fetch; the task is retried only once that version moves. */
  const failedAt = new Map<string, number>();

  async function refresh(taskId: string): Promise<void> {
    if (inFlight.has(taskId)) return;
    inFlight.add(taskId);
    const { epoch } = peek();
    dispatch({ type: 'task/loading', taskId });
    try {
      const detail = await api.get<TaskDetailPage>(paths.task(segment, taskId));
      failedAt.delete(taskId);
      dispatch({ type: 'task/loaded', epoch, detail });
    } catch (error) {
      if (error instanceof SegmentMismatch) return;
      failedAt.set(taskId, linkedVersion(taskId));
      dispatch({
        type: 'task/failed',
        taskId,
        error: error instanceof ApiFailure ? error.code : 'unavailable',
      });
    } finally {
      inFlight.delete(taskId);
    }
  }

  const linkedVersion = (taskId: string): number =>
    peek().conversation?.tasks.find((task) => task.id === taskId)?.version ?? -1;

  const retryable = (taskId: string): boolean =>
    !inFlight.has(taskId) && failedAt.get(taskId) !== linkedVersion(taskId);

  function wanted(): readonly string[] {
    const state = peek();
    const linked = tasksToFetch(state).filter(retryable);
    const panelTask = taskOfPanel(state.route.panel);
    const panelNeeds =
      panelTask !== null &&
      taskEntry(state.tasks, panelTask).detail === null &&
      retryable(panelTask) &&
      !linked.includes(panelTask);
    return panelNeeds ? [...linked, panelTask] : linked;
  }

  function start(): () => void {
    return effect(() => {
      // Subscribe to the slices that decide what to fetch; the work itself reads via peek.
      void store.conversation.value;
      void store.route.value;
      void store.tasks.value;
      for (const taskId of wanted()) void refresh(taskId);
    });
  }

  async function command(
    taskId: string,
    command: TaskCommand,
    body: unknown = {},
  ): Promise<CommandOutcome> {
    try {
      await api.post<TaskCommandReply>(paths.taskCommand(segment, taskId, command), body);
    } catch (error) {
      if (!(error instanceof SegmentMismatch)) {
        await refresh(taskId);
        return failureOf(error);
      }
    }
    await refresh(taskId);
    return { ok: true };
  }

  return { start, refresh, command };
}
