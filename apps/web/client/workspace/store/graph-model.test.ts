import { describe, expect, it } from 'vitest';

import { holdProjection, layers, navigate, safeHref } from './graph-model.js';
import { createGraphSync } from './graph-sync.js';

import type { GraphHeld } from './graph-model.js';
import type { GraphProjection, ProjectionNode } from '@agent-works/domain/teamwork-graph-contract';

const AT = '2026-11-04T10:00:00.000Z';
const node = (
  key: string,
  dependsOn: string[] = [],
  state: ProjectionNode['state'] = 'ready',
): ProjectionNode => ({
  key,
  title: key,
  state,
  reason: null,
  dependsOn,
  attempt: 1,
  retryAt: null,
  approval: null,
  updatedAt: AT,
  result: null,
});
const projection = (
  serverRevision: number,
  taskVersion: number,
  nodes: ProjectionNode[] = [node('a')],
): GraphProjection => ({
  contractVersion: 'teamwork.graph.v1',
  taskId: '11111111-1111-4111-8111-111111111111',
  serverRevision,
  taskVersion,
  digest: 'a'.repeat(64),
  updatedAt: AT,
  nodes,
});

describe('holdProjection', () => {
  it('converges on the newest revision whatever the arrival order', () => {
    const events = [
      projection(2, 5),
      projection(1, 9),
      projection(2, 3),
      projection(2, 5),
      projection(3, 1),
      projection(2, 8),
    ];
    const orders = [events, [...events].reverse(), [events[4], ...events.slice(0, 4), events[5]]];
    for (const order of orders) {
      const held = order.reduce<GraphHeld>(holdProjection, undefined);
      expect([held?.serverRevision, held?.taskVersion]).toEqual([3, 1]);
    }
  });

  it('ignores a duplicate event', () => {
    const first = projection(2, 5);
    expect(holdProjection(first, { ...first })).toBe(first);
  });
});

describe('graph sync', () => {
  it('drops a slow reply that overtakes a newer one and refetches after a drop', async () => {
    const seen: (GraphHeld | undefined)[] = [];
    const infos: boolean[] = [];
    let next: () => Promise<{ projection: GraphProjection | null; taskVersion: number }>;
    const sync = createGraphSync({
      fetchGraph: () => next(),
      onChange: (held, info) => {
        seen.push(held);
        infos.push(info.offline);
      },
    });
    let release: (value: { projection: GraphProjection; taskVersion: number }) => void = () =>
      undefined;
    next = () => new Promise((resolve) => (release = resolve));
    const slow = sync.resync();
    sync.receive({ projection: projection(2, 7), taskVersion: 7 });
    release({ projection: projection(2, 4), taskVersion: 4 });
    await slow;
    expect(sync.held()?.taskVersion).toBe(7);

    next = () => Promise.reject(new Error('offline'));
    await sync.resync();
    expect(infos.at(-1)).toBe(true);
    expect(sync.held()?.taskVersion).toBe(7);

    next = () => Promise.resolve({ projection: projection(3, 2), taskVersion: 2 });
    await sync.resync();
    expect([sync.held()?.serverRevision, infos.at(-1)]).toEqual([3, false]);
    expect(seen.length).toBeGreaterThan(2);
  });

  it('reports an empty graph instead of failing', async () => {
    let last = false;
    const sync = createGraphSync({
      fetchGraph: () => Promise.resolve({ projection: null, taskVersion: 1 }),
      onChange: (_held, info) => (last = info.empty),
    });
    await sync.resync();
    expect(last).toBe(true);
  });
});

const layerKeys = (layer: readonly ProjectionNode[]) => layer.map((n) => n.key);

describe('keyboard navigation', () => {
  const nodes = [node('a'), node('b'), node('c', ['a']), node('d', ['b', 'c'])];
  it('lays nodes out by dependency depth', () => {
    const keys = layers(nodes).map(layerKeys);
    expect(keys).toEqual([['a', 'b'], ['c'], ['d']]);
  });
  it('moves across layers and within a layer and stays put at the edges', () => {
    expect(navigate(nodes, 'a', 'ArrowDown')).toBe('b');
    expect(navigate(nodes, 'b', 'ArrowDown')).toBe('b');
    expect(navigate(nodes, 'a', 'ArrowRight')).toBe('c');
    expect(navigate(nodes, 'c', 'ArrowRight')).toBe('d');
    expect(navigate(nodes, 'd', 'ArrowRight')).toBe('d');
    expect(navigate(nodes, 'c', 'ArrowLeft')).toBe('a');
    expect(navigate(nodes, 'a', 'ArrowLeft')).toBe('a');
    expect(navigate(nodes, 'c', 'Home')).toBe('a');
    expect(navigate(nodes, 'a', 'End')).toBe('d');
  });
  it('recovers when the focused node disappeared', () => {
    expect(navigate(nodes, 'gone', 'ArrowRight')).toBe('a');
  });
});

describe('result links', () => {
  it('allows only same-origin paths', () => {
    expect(safeHref('/s/alpha/tasks/x')).toBe('/s/alpha/tasks/x');
    expect(safeHref('//evil.example')).toBeUndefined();
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('https://evil.example')).toBeUndefined();
  });
});
