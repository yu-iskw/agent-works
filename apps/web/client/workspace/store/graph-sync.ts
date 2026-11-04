// Keeps one projection converged on the server. Replies can overtake each other and a connection
// can drop, so every reply passes `holdProjection`; reconnecting always refetches the whole graph.

import { holdProjection } from './graph-model.js';

import type { GraphHeld } from './graph-model.js';
import type { GraphProjection } from '@agent-works/domain/teamwork-graph-contract';

export type GraphReply = {
  readonly projection: GraphProjection | null;
  readonly taskVersion: number;
};

export type GraphStatusInfo = {
  readonly loaded: boolean;
  readonly offline: boolean;
  readonly empty: boolean;
};

export type GraphSyncDeps = {
  readonly fetchGraph: () => Promise<GraphReply>;
  readonly onChange: (held: GraphHeld, status: GraphStatusInfo) => void;
};

export type GraphSync = {
  /** Fetch now: first load, polling, reconnect and after a refused mutation. */
  readonly resync: () => Promise<void>;
  /** A reply or event obtained elsewhere, such as a mutation reply. */
  readonly receive: (reply: GraphReply) => void;
  readonly held: () => GraphHeld;
};

export function createGraphSync(deps: GraphSyncDeps): GraphSync {
  let held: GraphHeld;
  let offline = false;
  let empty = false;
  const emit = (loaded: boolean) => deps.onChange(held, { loaded, offline, empty });
  function receive(reply: GraphReply): void {
    offline = false;
    if (reply.projection === null) empty = held === undefined;
    else {
      empty = false;
      held = holdProjection(held, reply.projection);
    }
    emit(true);
  }
  async function resync(): Promise<void> {
    try {
      receive(await deps.fetchGraph());
    } catch {
      offline = true;
      emit(held !== undefined || empty);
    }
  }
  return { resync, receive, held: () => held };
}
