// Side effects for the bounded lists (Work, Results, Inbox), the sidebar refresh, the recap and
// the identity editor. Mounted as `effects.lists` and `effects.identity`.

import { api as paths } from '../../../shared/contract.js';
import { conversationRoute } from '../../../shared/route.js';
import { SegmentMismatch } from '../api.js';

import { inboxPage, inboxPanel } from './inbox-target.js';
import { resultKey } from './lists.js';
import { teammateForTask } from './selectors.js';

import type { Api } from '../api.js';
import type { ListName } from './lists.js';
import type { Router } from './router.js';
import type { Store } from './store.js';
import type {
  InboxRow,
  ListPage,
  RecapView,
  ResultRow,
  SkillPatch,
  TaskDetailPage,
  TaskFilter,
  TaskRow,
  TeammateDetail,
  TeammateIdentityPatch,
  TeammatesPage,
} from '../../../shared/contract.js';
import type { PanelRoute } from '../../../shared/route.js';

/** What locating a task's conversation needs; a full row or a result entry both provide it. */
type TaskRef = Pick<TaskRow, 'id' | 'conversationId' | 'resultOwner'>;

export type ListEffects = {
  readonly setWorkFilter: (filter: TaskFilter) => void;
  /** Debounced server-side search for Work and Results; the Teammates tab filters locally. */
  readonly search: (list: 'work' | 'results', q: string) => void;
  /** Loads the first page when the list is idle, so a tab fetches only when first shown. */
  readonly ensure: (list: ListName) => void;
  readonly loadMore: (list: ListName) => void;
  readonly reload: (list: ListName) => void;
  /** Opens a task in its conversation with `panel`; a gone teammate shows the missing panel. */
  readonly openTask: (task: TaskRef, panel: PanelRoute) => void;
  readonly openResult: (row: ResultRow) => void;
  readonly openInboxItem: (item: InboxRow) => Promise<void>;
  readonly refreshTeammates: () => Promise<void>;
  readonly recap: () => Promise<RecapView>;
};

export type IdentityEffects = {
  readonly detail: (teammateId: string) => Promise<TeammateDetail>;
  readonly save: (teammateId: string, patch: TeammateIdentityPatch) => Promise<TeammateDetail>;
  readonly setSkill: (teammateId: string, patch: SkillPatch) => Promise<TeammateDetail>;
};

export type ListEffectsDeps = {
  readonly store: Store;
  readonly api: Api;
  readonly router: Router;
  readonly debounce: (run: () => void) => void;
  /** Full-page navigation, for items that open outside the workspace. */
  readonly assign: (url: string) => void;
};

export function createListEffects(deps: ListEffectsDeps): {
  readonly lists: ListEffects;
  readonly identity: IdentityEffects;
} {
  const { store, api, router } = deps;
  const { dispatch, peek } = store;
  const segment = peek().scope.segment;

  const select = (list: ListName, key: string | null) =>
    dispatch({ type: 'list/select', list, key });

  async function refreshTeammates(): Promise<void> {
    const { epoch } = peek();
    try {
      const page = await api.get<TeammatesPage>(paths.teammates(segment));
      dispatch({ type: 'sidebar/loaded', epoch, page, at: Date.now() });
    } catch {
      // The rows keep their last known flags; the next cadence retries.
    }
  }

  function listPath(list: ListName, cursor: string | null): string {
    const lists = peek().lists;
    if (list === 'work')
      return paths.tasks(segment, { status: lists.work.filter, q: lists.work.q, cursor });
    if (list === 'results') return paths.results(segment, { q: lists.results.q, cursor });
    return paths.inbox(segment, { cursor });
  }

  // `list` ranges over the closed ListName union in every lookup below.
  /* eslint-disable security/detect-object-injection */
  async function load(list: ListName, cursor: string | null): Promise<void> {
    const generation = peek().lists[list].generation;
    dispatch({ type: 'list/loading', list, generation });
    try {
      const page = await api.get<ListPage<never>>(listPath(list, cursor));
      dispatch({ type: 'list/loaded', list, generation, page });
      dispatch({ type: 'net/ok' });
    } catch (error) {
      dispatch({ type: 'list/failed', list, generation });
      if (!(error instanceof SegmentMismatch)) dispatch({ type: 'net/failure' });
    }
  }

  const ensure = (list: ListName): void => {
    if (peek().lists[list].status === 'idle') void load(list, null);
  };

  const loadMore = (list: ListName): void => {
    const current = peek().lists[list];
    if (current.status !== 'loading' && current.nextCursor !== null)
      void load(list, current.nextCursor);
  };
  /* eslint-enable security/detect-object-injection */

  const missing = (taskId: string): void =>
    router.navigate({ ...peek().route, panel: { kind: 'missing', what: 'task', id: taskId } });

  function openTask(task: TaskRef, panel: PanelRoute): void {
    const row = teammateForTask(peek(), task);
    if (row === undefined) missing(task.id);
    else router.navigate({ ...conversationRoute(segment, row.id), panel });
  }

  async function openInboxItem(item: InboxRow): Promise<void> {
    select('inbox', item.id);
    const page = inboxPage(segment, item);
    if (page !== undefined) return deps.assign(page);
    const panel = inboxPanel(item);
    const known = peek().lists.work.items.find((task) => task.id === item.taskId);
    if (known !== undefined) return openTask(known, panel);
    try {
      const detail = await api.get<TaskDetailPage & { readonly segment: string }>(
        paths.task(segment, item.taskId),
      );
      openTask(detail.task, panel);
    } catch {
      missing(item.taskId);
    }
  }

  async function afterIdentityChange(detail: TeammateDetail): Promise<TeammateDetail> {
    await refreshTeammates();
    return detail;
  }

  return {
    lists: {
      setWorkFilter: (filter) => {
        dispatch({ type: 'work/filter', filter });
        void load('work', null);
      },
      search: (list, q) => {
        dispatch({ type: 'list/query', list, q });
        deps.debounce(() => ensure(list));
      },
      ensure,
      loadMore,
      reload: (list) => {
        dispatch({ type: 'list/reset', list });
        void load(list, null);
      },
      openTask: (task, panel) => {
        select('work', task.id);
        openTask(task, panel);
      },
      openResult: (row) => {
        select('results', resultKey(row));
        openTask(
          { id: row.taskId, conversationId: row.conversationId, resultOwner: row.producedBy.id },
          {
            kind: 'result',
            taskId: row.taskId,
            revision: row.revision,
            view: 'result',
            citation: null,
            compareTo: null,
          },
        );
      },
      openInboxItem,
      refreshTeammates,
      recap: () => api.get<RecapView>(paths.recap(segment)),
    },
    identity: {
      detail: (teammateId) => api.get<TeammateDetail>(paths.teammate(segment, teammateId)),
      save: (teammateId, patch) =>
        api
          .post<TeammateDetail>(paths.teammate(segment, teammateId), patch)
          .then(afterIdentityChange),
      setSkill: (teammateId, patch) =>
        api
          .post<TeammateDetail>(paths.teammateSkills(segment, teammateId), patch)
          .then(afterIdentityChange),
    },
  };
}
