// The workspace URL grammar, compiled into both the server (shell routes) and the client (router).
// `parseRoute` and `formatRoute` are inverses for every route a URL can express; `missing` is the
// one panel the server bootstraps for a deep link to something gone, and it formats as the bare
// conversation route so a reload lands somewhere safe.

type Surface = 'conversation' | 'work' | 'results';
type ResultView = 'result' | 'sources' | 'changes';
type MissingWhat = 'teammate' | 'task' | 'revision';

export type PanelRoute =
  | { readonly kind: 'none' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'preferences' }
  | { readonly kind: 'teammate' }
  | { readonly kind: 'draft'; readonly draftId: string }
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'plan'; readonly taskId: string; readonly version: number }
  | { readonly kind: 'approval'; readonly taskId: string; readonly approvalId: string }
  | {
      readonly kind: 'result';
      readonly taskId: string;
      readonly revision: number;
      readonly view: ResultView;
      readonly citation: string | null;
      readonly compareTo: number | null;
    }
  | { readonly kind: 'missing'; readonly what: MissingWhat; readonly id: string };

export type Route = {
  readonly segment: string;
  /** The teammate whose conversation is open; null only for `/s/<seg>` before startup resolves it. */
  readonly teammate: string | null;
  readonly surface: Surface;
  readonly panel: PanelRoute;
};

const SEGMENT = '[a-z][a-z0-9-]{1,30}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const NUMBER = '\\d{1,4}';
const TOKEN = '[A-Za-z0-9_.:-]{1,80}';

const ROOT = new RegExp(`^/s/(${SEGMENT})/?$`);
const TEAMMATE = new RegExp(`^/s/(${SEGMENT})/teammates/(${UUID})(.*)$`);

type PanelPattern = {
  readonly pattern: RegExp;
  readonly panel: (m: RegExpExecArray, query: URLSearchParams) => PanelRoute;
};

const PANEL_PATTERNS: readonly PanelPattern[] = [
  { pattern: /^$/, panel: () => ({ kind: 'none' }) },
  { pattern: /^\/details$/, panel: () => ({ kind: 'teammate' }) },
  { pattern: /^\/inbox$/, panel: () => ({ kind: 'inbox' }) },
  { pattern: /^\/preferences$/, panel: () => ({ kind: 'preferences' }) },
  { pattern: new RegExp(`^/drafts/(${UUID})$`), panel: (m) => ({ kind: 'draft', draftId: m[1] }) },
  { pattern: new RegExp(`^/tasks/(${UUID})$`), panel: (m) => ({ kind: 'task', taskId: m[1] }) },
  {
    pattern: new RegExp(`^/tasks/(${UUID})/plan/(${NUMBER})$`),
    panel: (m) => ({ kind: 'plan', taskId: m[1], version: Number(m[2]) }),
  },
  {
    pattern: new RegExp(`^/tasks/(${UUID})/approvals/(${UUID})$`),
    panel: (m) => ({ kind: 'approval', taskId: m[1], approvalId: m[2] }),
  },
  {
    pattern: new RegExp(`^/tasks/(${UUID})/results/(${NUMBER})(/sources|/changes|)$`),
    panel: (m, query) => {
      const view: ResultView =
        m[3] === '/sources' ? 'sources' : m[3] === '/changes' ? 'changes' : 'result';
      const citation = query.get('citation');
      const compare = Number(query.get('compare'));
      return {
        kind: 'result',
        taskId: m[1],
        revision: Number(m[2]),
        view,
        citation:
          view === 'sources' && citation !== null && new RegExp(`^${TOKEN}$`).test(citation)
            ? citation
            : null,
        compareTo: view === 'changes' && Number.isInteger(compare) && compare > 0 ? compare : null,
      };
    },
  },
];

function surfaceOf(query: URLSearchParams): Surface {
  const value = query.get('surface');
  return value === 'work' || value === 'results' ? value : 'conversation';
}

/** `undefined` when the URL is not a workspace route (the old pages keep their own routing). */
export function parseRoute(pathname: string, search = ''): Route | undefined {
  const query = new URLSearchParams(search);
  const root = ROOT.exec(pathname);
  if (root !== null)
    return { segment: root[1], teammate: null, surface: surfaceOf(query), panel: { kind: 'none' } };
  const m = TEAMMATE.exec(pathname);
  if (m === null) return undefined;
  const rest = m[3];
  for (const { pattern, panel } of PANEL_PATTERNS) {
    const hit = pattern.exec(rest);
    if (hit !== null)
      return { segment: m[1], teammate: m[2], surface: surfaceOf(query), panel: panel(hit, query) };
  }
  return undefined;
}

type Formatted = { readonly path: string; readonly query: readonly string[] };
const plain = (path: string): Formatted => ({ path, query: [] });

function resultPath(panel: Extract<PanelRoute, { kind: 'result' }>): Formatted {
  const base = `/tasks/${panel.taskId}/results/${panel.revision}`;
  if (panel.view === 'sources')
    return {
      path: `${base}/sources`,
      query: panel.citation === null ? [] : [`citation=${encodeURIComponent(panel.citation)}`],
    };
  if (panel.view === 'changes')
    return {
      path: `${base}/changes`,
      query: panel.compareTo === null ? [] : [`compare=${panel.compareTo}`],
    };
  return plain(base);
}

const PANEL_PATHS: {
  readonly [K in PanelRoute['kind']]: (panel: Extract<PanelRoute, { kind: K }>) => Formatted;
} = {
  none: () => plain(''),
  missing: () => plain(''),
  teammate: () => plain('/details'),
  inbox: () => plain('/inbox'),
  preferences: () => plain('/preferences'),
  draft: (panel) => plain(`/drafts/${panel.draftId}`),
  task: (panel) => plain(`/tasks/${panel.taskId}`),
  plan: (panel) => plain(`/tasks/${panel.taskId}/plan/${panel.version}`),
  approval: (panel) => plain(`/tasks/${panel.taskId}/approvals/${panel.approvalId}`),
  result: resultPath,
};

function panelPath(panel: PanelRoute): Formatted {
  // The map is keyed by the union's own discriminant, so the narrowing is sound.
  return (PANEL_PATHS[panel.kind] as (panel: PanelRoute) => Formatted)(panel);
}

export function formatRoute(route: Route): string {
  const head = `/s/${route.segment}${route.teammate === null ? '' : `/teammates/${route.teammate}`}`;
  const { path, query } =
    route.teammate === null ? { path: '', query: [] } : panelPath(route.panel);
  const params = route.surface === 'conversation' ? query : [`surface=${route.surface}`, ...query];
  return `${head}${path}${params.length === 0 ? '' : `?${params.join('&')}`}`;
}

export const conversationRoute = (segment: string, teammate: string): Route => ({
  segment,
  teammate,
  surface: 'conversation',
  panel: { kind: 'none' },
});

/** True when both routes show the same conversation, whatever panel or surface is open. */
export const sameConversation = (a: Route, b: Route): boolean =>
  a.segment === b.segment && a.teammate === b.teammate;
