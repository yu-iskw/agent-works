// Route constructors for the review panel. The route is the only selection state, so opening a
// result, switching a revision or following a citation is always a navigation.

import type { PanelRoute, Route } from '../../../shared/route.js';

type ResultPanel = Extract<PanelRoute, { kind: 'result' }>;
export type ResultView = ResultPanel['view'];

const withPanel = (route: Route, panel: PanelRoute): Route => ({ ...route, panel });

export const resultRoute = (
  route: Route,
  taskId: string,
  revision: number,
  view: ResultView = 'result',
): Route =>
  withPanel(route, { kind: 'result', taskId, revision, view, citation: null, compareTo: null });

export const planRoute = (route: Route, taskId: string, version: number): Route =>
  withPanel(route, { kind: 'plan', taskId, version });

export const approvalRoute = (route: Route, taskId: string, approvalId: string): Route =>
  withPanel(route, { kind: 'approval', taskId, approvalId });

export const taskRoute = (route: Route, taskId: string): Route =>
  withPanel(route, { kind: 'task', taskId });

/** The same result at another revision; citation and comparison belong to the revision they came from. */
export function withRevision(route: Route, revision: number): Route {
  const panel = route.panel;
  if (panel.kind !== 'result') return route;
  return withPanel(route, { ...panel, revision, citation: null, compareTo: null });
}

export function withView(route: Route, view: ResultView): Route {
  const panel = route.panel;
  if (panel.kind !== 'result' || panel.view === view) return route;
  return withPanel(route, { ...panel, view, citation: null, compareTo: null });
}

/** Sources at the cited entry, from any view of the same revision. */
export function citationRoute(route: Route, citation: string): Route {
  const panel = route.panel;
  if (panel.kind !== 'result') return route;
  return withPanel(route, { ...panel, view: 'sources', citation, compareTo: null });
}

export function backToResultRoute(route: Route): Route {
  return withView(route, 'result');
}

/** The task a panel reads from, or null for panels that need no task detail. */
export function taskOfPanel(panel: PanelRoute): string | null {
  switch (panel.kind) {
    case 'task':
    case 'plan':
    case 'approval':
    case 'result':
      return panel.taskId;
    case 'none':
    case 'teammate':
    case 'inbox':
    case 'preferences':
    case 'recap':
    case 'draft':
    case 'missing':
      return null;
  }
}

/** Where a reading position is remembered; one key per revision view so switching never mixes them. */
export function positionKey(panel: PanelRoute): string | null {
  switch (panel.kind) {
    case 'result':
      return `${panel.taskId}:${panel.revision}:${panel.view}`;
    case 'plan':
      return `${panel.taskId}:plan:${panel.version}`;
    case 'approval':
      return `${panel.taskId}:approval:${panel.approvalId}`;
    case 'task':
      return `${panel.taskId}:task`;
    case 'none':
    case 'teammate':
    case 'inbox':
    case 'preferences':
    case 'recap':
    case 'draft':
    case 'missing':
      return null;
  }
}

export const PANEL_TITLES: Readonly<Record<PanelRoute['kind'], string>> = {
  none: '',
  missing: 'Not available',
  inbox: 'Attention inbox',
  preferences: 'Preferences',
  recap: 'Coordinator recap',
  teammate: 'Teammate details',
  draft: 'Task draft',
  task: 'Task',
  plan: 'Review plan',
  approval: 'Review action',
  result: 'Result',
};
