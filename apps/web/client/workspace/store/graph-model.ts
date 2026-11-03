// Pure model of the task status graph: which server projection to hold, how to lay it out, how the
// keyboard moves between nodes and what a refused mutation says. No DOM and no fetch.

import { isNewerProjection } from '@agent-works/domain/teamwork-graph-contract';

import type {
  GraphProjection,
  NodeReason,
  NodeState,
  ProjectionNode,
} from '@agent-works/domain/teamwork-graph-contract';

export type GraphHeld = GraphProjection | undefined;

/** Keeps the newest projection; an older or duplicate one (late reply, replayed event) is dropped. */
export function holdProjection(held: GraphHeld, incoming: GraphProjection): GraphHeld {
  return isNewerProjection(held, incoming) ? incoming : held;
}

export const STATE_LABEL: Readonly<Record<NodeState, string>> = {
  blocked: 'Blocked',
  ready: 'Ready',
  running: 'Running',
  succeeded: 'Done',
  retry_wait: 'Waiting to retry',
  failed: 'Failed',
  awaiting_approval: 'Needs your approval',
  uncertain: 'Outcome unconfirmed',
  cancelled: 'Cancelled',
};

export const REASON_LABEL: Readonly<Record<NodeReason, string>> = {
  prerequisite_pending: 'Waiting for an earlier step',
  prerequisite_failed: 'An earlier step failed',
  plan_not_approved: 'The plan is not approved yet',
  retry_backoff: 'Retrying automatically',
  member_input: 'Waiting for your answer',
  publish_approval: 'Waiting for your approval to publish',
  effect_unconfirmed: 'Not confirmed; reconcile before retrying',
};

const CHANGED =
  'The graph changed while you were looking at it. It was refreshed; nothing was done.';
export const CONFLICT_TEXT: Readonly<Partial<Record<string, string>>> = {
  stale_revision: CHANGED,
  digest_mismatch: CHANGED,
  not_live: 'This graph is no longer active. It was refreshed; nothing was done.',
};

/** Layer of each node: 0 without prerequisites, else one more than its deepest prerequisite. */
export function layers(nodes: readonly ProjectionNode[]): readonly (readonly ProjectionNode[])[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const depth = new Map<string, number>();
  const visit = (node: ProjectionNode, seen: ReadonlySet<string>): number => {
    const known = depth.get(node.key);
    if (known !== undefined) return known;
    const next = new Set([...seen, node.key]);
    const parents = node.dependsOn
      .map((key) => byKey.get(key))
      .filter((p): p is ProjectionNode => p !== undefined && !seen.has(p.key));
    const value = parents.length === 0 ? 0 : 1 + Math.max(...parents.map((p) => visit(p, next)));
    depth.set(node.key, value);
    return value;
  };
  const out: ProjectionNode[][] = [];
  for (const node of nodes) {
    const d = visit(node, new Set());
    while (out.length <= d) out.push([]);
    // eslint-disable-next-line security/detect-object-injection
    out[d].push(node);
  }
  return out;
}

export type NavKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';
export const isNavKey = (key: string): key is NavKey =>
  ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key);

/** The key of the node focus moves to, or the same key when there is nowhere to go. */
export function navigate(nodes: readonly ProjectionNode[], current: string, key: NavKey): string {
  const grid = layers(nodes);
  const col = grid.findIndex((layer) => layer.some((n) => n.key === current));
  if (col < 0) return nodes.at(0)?.key ?? current;
  // eslint-disable-next-line security/detect-object-injection
  const layer = grid[col];
  const row = layer.findIndex((n) => n.key === current);
  const at = (c: number): string => {
    const target = c < 0 ? undefined : grid.at(c);
    return target === undefined || target.length === 0
      ? current
      : target[Math.min(row, target.length - 1)].key;
  };
  switch (key) {
    case 'ArrowRight':
      return at(col + 1);
    case 'ArrowLeft':
      return at(col - 1);
    case 'ArrowDown':
      return layer[Math.min(row + 1, layer.length - 1)].key;
    case 'ArrowUp':
      return layer[Math.max(row - 1, 0)].key;
    case 'Home':
      return grid[0][0].key;
    case 'End':
      return grid.at(-1)?.at(-1)?.key ?? current;
  }
}

/** Only a same-origin path may become a link; anything else is shown as text. */
export const safeHref = (href: string): string | undefined =>
  href.startsWith('/') && !href.startsWith('//') ? href : undefined;
