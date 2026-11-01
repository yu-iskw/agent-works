// Task details the timeline and panels read. One entry per task id; the newest version wins and
// a poll that reports an unchanged version never triggers a fetch.

import type { TaskDetailPage } from '../../../shared/contract.js';

export type TaskEntry = {
  readonly detail: TaskDetailPage | null;
  readonly loading: boolean;
  /** The BFF error code of the last failed fetch; cleared by the next success. */
  readonly error: string | null;
};

export type TasksState = Readonly<Record<string, TaskEntry>>;

const EMPTY: TaskEntry = { detail: null, loading: false, error: null };

// Task ids are segment uuids used as keys of a plain record.
// eslint-disable-next-line security/detect-object-injection
export const taskEntry = (tasks: TasksState, taskId: string): TaskEntry => tasks[taskId] ?? EMPTY;

export const taskDetail = (tasks: TasksState, taskId: string): TaskDetailPage | null =>
  taskEntry(tasks, taskId).detail;

const put = (tasks: TasksState, taskId: string, entry: TaskEntry): TasksState => ({
  ...tasks,
  [taskId]: entry,
});

export function taskLoading(tasks: TasksState, taskId: string): TasksState {
  const had = taskEntry(tasks, taskId);
  return had.loading ? tasks : put(tasks, taskId, { ...had, loading: true });
}

export function taskLoaded(tasks: TasksState, detail: TaskDetailPage): TasksState {
  const taskId = detail.task.id;
  const had = taskEntry(tasks, taskId);
  const stale = had.detail !== null && had.detail.task.version > detail.task.version;
  return put(tasks, taskId, { detail: stale ? had.detail : detail, loading: false, error: null });
}

export function taskFailed(tasks: TasksState, taskId: string, error: string): TasksState {
  return put(tasks, taskId, { ...taskEntry(tasks, taskId), loading: false, error });
}
