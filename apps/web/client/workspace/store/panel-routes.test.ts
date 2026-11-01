import { describe, expect, it } from 'vitest';

import { conversationRoute, formatRoute, parseRoute } from '../../../shared/route.js';

import {
  approvalRoute,
  backToResultRoute,
  citationRoute,
  planRoute,
  positionKey,
  resultRoute,
  taskOfPanel,
  taskRoute,
  withRevision,
  withView,
} from './panel-routes.js';

const T = '11111111-2222-4333-8444-555555555555';
const TASK = '22222222-2222-4333-8444-555555555555';
const APPROVAL = '33333333-2222-4333-8444-555555555555';
const base = conversationRoute('alpha', T);

const roundTrip = (route: ReturnType<typeof resultRoute>) =>
  parseRoute(...splitUrl(formatRoute(route)));
const splitUrl = (url: string): [string, string] => {
  const i = url.indexOf('?');
  return i === -1 ? [url, ''] : [url.slice(0, i), url.slice(i)];
};

describe('panel routes', () => {
  it('opens each review panel at a URL that parses back to the same route', () => {
    for (const route of [
      resultRoute(base, TASK, 2),
      resultRoute(base, TASK, 2, 'changes'),
      planRoute(base, TASK, 3),
      approvalRoute(base, TASK, APPROVAL),
      taskRoute(base, TASK),
      citationRoute(resultRoute(base, TASK, 2), 'E3'),
    ])
      expect(roundTrip(route)).toEqual(route);
  });

  it('follows a citation into Sources and comes back to Result without it', () => {
    const cited = citationRoute(resultRoute(base, TASK, 2), 'E3');
    expect(cited.panel).toEqual({
      kind: 'result',
      taskId: TASK,
      revision: 2,
      view: 'sources',
      citation: 'E3',
      compareTo: null,
    });
    expect(formatRoute(cited)).toBe(
      `/s/alpha/teammates/${T}/tasks/${TASK}/results/2/sources?citation=E3`,
    );
    expect(backToResultRoute(cited)).toEqual(resultRoute(base, TASK, 2));
  });

  it('drops the citation and comparison when the revision or view changes', () => {
    const cited = citationRoute(resultRoute(base, TASK, 2), 'E3');
    expect(withRevision(cited, 3)).toEqual(resultRoute(base, TASK, 3, 'sources'));
    expect(withView(cited, 'changes')).toEqual(resultRoute(base, TASK, 2, 'changes'));
    expect(withView(cited, 'sources')).toBe(cited);
  });

  it('leaves non-result panels alone', () => {
    const plan = planRoute(base, TASK, 1);
    expect(withRevision(plan, 2)).toBe(plan);
    expect(citationRoute(plan, 'E1')).toBe(plan);
  });

  it('names the task each panel reads and where its reading position lives', () => {
    expect(taskOfPanel(resultRoute(base, TASK, 2).panel)).toBe(TASK);
    expect(taskOfPanel(planRoute(base, TASK, 1).panel)).toBe(TASK);
    expect(taskOfPanel(approvalRoute(base, TASK, APPROVAL).panel)).toBe(TASK);
    expect(taskOfPanel(taskRoute(base, TASK).panel)).toBe(TASK);
    expect(taskOfPanel({ kind: 'teammate' })).toBeNull();
    expect(taskOfPanel({ kind: 'none' })).toBeNull();
    expect(positionKey(resultRoute(base, TASK, 2, 'sources').panel)).toBe(`${TASK}:2:sources`);
    expect(positionKey({ kind: 'inbox' })).toBeNull();
  });
});
