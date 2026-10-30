import { describe, expect, it } from 'vitest';

import { conversationRoute, formatRoute, parseRoute, sameConversation } from './route.js';

import type { PanelRoute, Route } from './route.js';

const T = '11111111-2222-4333-8444-555555555555';
const TASK = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APPROVAL = '99999999-8888-4777-8666-555555555555';

const PANELS: readonly PanelRoute[] = [
  { kind: 'none' },
  { kind: 'teammate' },
  { kind: 'inbox' },
  { kind: 'preferences' },
  { kind: 'draft', draftId: APPROVAL },
  { kind: 'task', taskId: TASK },
  { kind: 'plan', taskId: TASK, version: 3 },
  { kind: 'approval', taskId: TASK, approvalId: APPROVAL },
  { kind: 'result', taskId: TASK, revision: 2, view: 'result', citation: null, compareTo: null },
  { kind: 'result', taskId: TASK, revision: 2, view: 'sources', citation: null, compareTo: null },
  { kind: 'result', taskId: TASK, revision: 2, view: 'sources', citation: 'E1', compareTo: null },
  { kind: 'result', taskId: TASK, revision: 4, view: 'changes', citation: null, compareTo: null },
  { kind: 'result', taskId: TASK, revision: 4, view: 'changes', citation: null, compareTo: 3 },
];

const split = (url: string) => {
  const i = url.indexOf('?');
  return i === -1 ? ([url, ''] as const) : ([url.slice(0, i), url.slice(i)] as const);
};

describe('route grammar', () => {
  it('round-trips every URL-expressible route in both directions', () => {
    for (const surface of ['conversation', 'work', 'results'] as const)
      for (const panel of PANELS) {
        const route: Route = { segment: 'alpha', teammate: T, surface, panel };
        const url = formatRoute(route);
        const [path, search] = split(url);
        expect(parseRoute(path, search)).toEqual(route);
        const again = parseRoute(path, search);
        expect(again === undefined ? '' : formatRoute(again)).toBe(url);
      }
  });

  it('formats the bare segment route without a teammate', () => {
    const route: Route = {
      segment: 'beta',
      teammate: null,
      surface: 'conversation',
      panel: { kind: 'none' },
    };
    expect(formatRoute(route)).toBe('/s/beta');
    expect(parseRoute('/s/beta')).toEqual(route);
    expect(parseRoute('/s/beta/')).toEqual(route);
  });

  it('formats a missing panel as the bare conversation route', () => {
    const route: Route = {
      segment: 'alpha',
      teammate: T,
      surface: 'conversation',
      panel: { kind: 'missing', what: 'task', id: TASK },
    };
    expect(formatRoute(route)).toBe(`/s/alpha/teammates/${T}`);
    expect(parseRoute(formatRoute(route))).toEqual(conversationRoute('alpha', T));
  });

  it('leaves non-workspace URLs to the page router', () => {
    expect(parseRoute('/s/alpha/inbox')).toBeUndefined();
    expect(parseRoute(`/s/alpha/teammates/${T}/export`)).toBeUndefined();
    expect(parseRoute(`/s/alpha/teammates/${T}/export.json`)).toBeUndefined();
    expect(parseRoute('/s/alpha/teammates')).toBeUndefined();
    expect(parseRoute(`/s/alpha/pages/teammates/${T}`)).toBeUndefined();
    expect(parseRoute(`/s/alpha/teammates/not-a-uuid`)).toBeUndefined();
    expect(parseRoute(`/s/Alpha/teammates/${T}`)).toBeUndefined();
    expect(parseRoute(`/s/alpha/teammates/${T}/tasks/${TASK}/results/x`)).toBeUndefined();
  });

  it('drops a citation outside the sources view and a compare outside changes', () => {
    const sources = parseRoute(`/s/alpha/teammates/${T}/tasks/${TASK}/results/1`, '?citation=E1');
    expect(sources?.panel).toEqual({
      kind: 'result',
      taskId: TASK,
      revision: 1,
      view: 'result',
      citation: null,
      compareTo: null,
    });
    const changes = parseRoute(
      `/s/alpha/teammates/${T}/tasks/${TASK}/results/2/changes`,
      '?compare=zero',
    );
    expect(changes?.panel).toMatchObject({ view: 'changes', compareTo: null });
    expect(parseRoute('/s/alpha', '?surface=bogus')?.surface).toBe('conversation');
  });

  it('compares conversations regardless of panel or surface', () => {
    const a = conversationRoute('alpha', T);
    const b: Route = { ...a, surface: 'work', panel: { kind: 'inbox' } };
    expect(sameConversation(a, b)).toBe(true);
    expect(sameConversation(a, { ...a, segment: 'beta' })).toBe(false);
    expect(sameConversation(a, { ...a, teammate: null })).toBe(false);
  });
});
