// Pure: the browser bundle imports this module, so it carries no zod and no Node imports.
import type {
  ActionApprovalView,
  AssignmentStatus,
  AssignmentView,
  MessageView,
  PlanView,
  TaskDetail,
  TeamworkStatus,
} from './teamwork.js';

export type Author =
  | { readonly kind: 'member' }
  | { readonly kind: 'system' }
  | { readonly kind: 'teammate'; readonly id: string; readonly name: string };

export type TeammateAuthor = Extract<Author, { kind: 'teammate' }>;

/** The task's observed stage. `running` is refined from its assignments; every other word is the status. */
export type Stage = Exclude<TeamworkStatus, 'running'> | 'queued' | 'reading' | 'contributing';

export type FailureStage = 'planning' | 'synthesis' | 'publish' | 'assignment' | 'action';
/** The member command that recovers: retry, reconcile, or decide between retry and proceed. */
export type Recovery = 'retry' | 'reconcile' | 'decide' | 'none';
export type InvalidApproval = 'decided' | 'stale_revision' | 'expired';

type CardBase = { readonly taskId: string; readonly taskTitle: string };

export type Card =
  | (CardBase & {
      readonly kind: 'running';
      readonly stage: Stage;
      readonly owner: Author;
      readonly done: number;
      readonly total: number;
      readonly latestRevision: number;
    })
  | (CardBase & {
      readonly kind: 'question';
      readonly assignmentId: string;
      readonly attempt: number;
      readonly author: TeammateAuthor;
      readonly question: string;
      readonly answered: boolean;
      readonly inboxRef: string;
    })
  | (CardBase & {
      readonly kind: 'plan';
      readonly version: number;
      readonly digest: string;
      readonly state: PlanView['state'];
      readonly summary: string;
      readonly assignments: number;
      readonly inboxRef: string;
    })
  | (CardBase & {
      readonly kind: 'result';
      readonly revision: number;
      readonly latest: number;
      readonly title: string;
      readonly summary: string;
      readonly unsupported: number;
      readonly limitations: number;
    })
  | (CardBase & {
      readonly kind: 'approval';
      readonly approvalId: string;
      readonly revision: number;
      readonly latestRevision: number;
      readonly expiresAt: string;
      readonly state: ActionApprovalView['state'];
      readonly destination: string;
      readonly account: string;
      /** The same checks `decideAction` makes: pending, latest revision, not expired. */
      readonly valid: boolean;
      readonly invalidReason: InvalidApproval | null;
      readonly inboxRef: string;
    })
  | (CardBase & {
      readonly kind: 'failure';
      readonly stage: FailureStage;
      readonly code: string;
      readonly message: string;
      readonly knownEffects: string;
      readonly recovery: Recovery;
      readonly resolved: boolean;
      /** Assignments that did not finish, so a partial failure stays visible. */
      readonly missing: readonly {
        readonly assignmentId: string;
        readonly author: TeammateAuthor;
        readonly status: AssignmentStatus;
      }[];
      readonly inboxRef: string;
    });

export type TimelineItem =
  | { readonly kind: 'day'; readonly id: string; readonly at: string; readonly date: string }
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly at: string;
      readonly messageId: string;
      readonly author: Author;
      readonly text: string;
      /** Continues the previous message: same author within five minutes, nothing in between. */
      readonly grouped: boolean;
      readonly pending: boolean;
      readonly taskId: string | null;
    }
  | {
      readonly kind: 'system';
      readonly id: string;
      readonly at: string;
      readonly messageId: string;
      readonly text: string;
      readonly taskId: string | null;
    }
  | {
      readonly kind: 'contribution';
      readonly id: string;
      readonly at: string;
      readonly taskId: string;
      readonly assignmentId: string;
      readonly author: TeammateAuthor;
      readonly status: AssignmentStatus;
      readonly summary: string | null;
      readonly statements: number;
      readonly question: string | null;
      readonly error: string | null;
    }
  | {
      readonly kind: 'card';
      readonly id: string;
      readonly at: string;
      readonly taskId: string;
      readonly card: Card;
    };

export type TimelineInput = {
  /** The conversation's teammate: author of every `teammate` message. */
  readonly teammate: { readonly id: string; readonly name: string };
  /** Pages may overlap; messages dedupe by id. */
  readonly messages: readonly MessageView[];
  /** Details of the tasks linked to the conversation; the newest version of a task wins. */
  readonly tasks: readonly TaskDetail[];
  /** Names for result owners that are not the conversation's teammate. */
  readonly teammates?: readonly { readonly id: string; readonly name: string }[];
  readonly now: string;
  /** Calendar day of a timestamp; defaults to the UTC date. */
  readonly dayOf?: (at: string) => string;
};

const GROUP_WINDOW_MS = 5 * 60 * 1000;
const CONTRIBUTION_STATUSES: ReadonlySet<AssignmentStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'needs_input',
]);
const KNOWN_EFFECTS: Record<Exclude<FailureStage, 'assignment' | 'action'>, string> = {
  planning: 'No work was dispatched.',
  synthesis: 'Contributions are kept; no result was produced.',
  publish: 'Nothing was published.',
};

const utcDay = (at: string): string => at.slice(0, 10);

function authorOf(message: MessageView, teammate: TimelineInput['teammate']): Author {
  if (message.role === 'member') return { kind: 'member' };
  if (message.role === 'system') return { kind: 'system' };
  return { kind: 'teammate', id: teammate.id, name: teammate.name };
}

const authorKey = (author: Author): string =>
  author.kind === 'teammate' ? `teammate:${author.id}` : author.kind;

type Names = ReadonlyMap<string, string>;

const teammateAuthor = (names: Names, id: string, fallback = 'Teammate'): TeammateAuthor => ({
  kind: 'teammate',
  id,
  name: names.get(id) ?? fallback,
});

function stageOf(detail: TaskDetail): Stage {
  if (detail.task.status !== 'running') return detail.task.status;
  const running = detail.assignments.filter((a) => a.status === 'running');
  if (running.length === 0) return 'queued';
  const reading = running.some(
    (a) =>
      !detail.events.some(
        (e) =>
          e.type === 'retrieval.completed' &&
          e.detail.assignmentId === a.id &&
          e.at >= (a.startedAt ?? ''),
      ),
  );
  return reading ? 'reading' : 'contributing';
}

function runningCard(detail: TaskDetail, names: Names): Card {
  const counted = detail.assignments.filter((a) => a.status !== 'superseded');
  return {
    kind: 'running',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    stage: stageOf(detail),
    owner: teammateAuthor(names, detail.task.resultOwner),
    done: counted.filter((a) => a.status === 'succeeded').length,
    total: counted.length,
    latestRevision: detail.task.latestRevision,
  };
}

function resultCard(detail: TaskDetail, revision: number): Card | undefined {
  const found = detail.revisions.find((r) => r.revision === revision);
  if (found === undefined) return undefined;
  return {
    kind: 'result',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    revision,
    latest: detail.task.latestRevision,
    title: found.content.title,
    summary: found.content.summary,
    unsupported: found.unsupported,
    limitations: found.content.limitations.length,
  };
}

/** The revision a legacy `result_ready` row (no ref) announced: the newest one created by then. */
function revisionAt(detail: TaskDetail, at: string): number | undefined {
  return detail.revisions.filter((r) => r.createdAt <= at).at(-1)?.revision;
}

function planCard(detail: TaskDetail, ref: string): Card | undefined {
  const version = Number(ref.slice('plan:'.length));
  const plan = detail.plans.find((p) => p.version === version);
  if (plan === undefined) return undefined;
  return {
    kind: 'plan',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    version,
    digest: plan.digest,
    state: plan.state,
    summary: plan.content.summary,
    assignments: plan.content.assignments.length,
    inboxRef: ref,
  };
}

function questionCard(detail: TaskDetail, ref: string, names: Names): Card | undefined {
  const [, assignmentId, attempt] = ref.split(':');
  const assignment = detail.assignments.find((a) => a.id === assignmentId);
  if (assignment === undefined) return undefined;
  const asked = Number(attempt);
  return {
    kind: 'question',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    assignmentId: assignment.id,
    attempt: asked,
    author: teammateAuthor(names, assignment.teammateId, assignment.teammateName),
    question: assignment.question ?? '',
    answered: !(assignment.status === 'needs_input' && assignment.attempt === asked),
    inboxRef: ref,
  };
}

function missingCard(detail: TaskDetail, ref: string, names: Names): Card {
  const ids = new Set(
    ref
      .slice('missing:'.length)
      .split(',')
      .map((part) => part.split('.')[0]),
  );
  const missing = detail.assignments
    .filter((a) => ids.has(a.id))
    .map((a) => ({
      assignmentId: a.id,
      author: teammateAuthor(names, a.teammateId, a.teammateName),
      status: a.status,
    }));
  return {
    kind: 'failure',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    stage: 'assignment',
    code: 'contributions_missing',
    message: `${ids.size} contribution${ids.size === 1 ? '' : 's'} did not finish`,
    knownEffects: 'Finished contributions are kept; the result would state the gap.',
    recovery: 'decide',
    resolved: detail.task.status !== 'needs_input',
    missing,
    inboxRef: ref,
  };
}

function approvalCard(detail: TaskDetail, ref: string, now: string): Card | undefined {
  const approval = detail.approvals.find((a) => a.id === ref.slice('approval:'.length));
  if (approval === undefined) return undefined;
  const revision = approval.proposal.revision;
  const invalidReason: InvalidApproval | null =
    approval.state !== 'pending'
      ? 'decided'
      : revision !== detail.task.latestRevision
        ? 'stale_revision'
        : approval.expiresAt <= now
          ? 'expired'
          : null;
  return {
    kind: 'approval',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    approvalId: approval.id,
    revision,
    latestRevision: detail.task.latestRevision,
    expiresAt: approval.expiresAt,
    state: approval.state,
    destination: approval.proposal.destination,
    account: approval.proposal.account,
    valid: invalidReason === null,
    invalidReason,
    inboxRef: ref,
  };
}

type FailedStage = Exclude<FailureStage, 'assignment' | 'action'>;

/** The `task.failed` event nearest the anchor; events and anchors are written in one transaction. */
function failedStage(detail: TaskDetail, at: string): FailedStage {
  const anchor = Date.parse(at);
  const nearest = detail.events
    .filter((e) => e.type === 'task.failed')
    .map((e) => ({ e, distance: Math.abs(Date.parse(e.at) - anchor) }))
    .sort((a, b) => a.distance - b.distance)
    .at(0)?.e;
  const stage = nearest?.detail.stage;
  return stage === 'synthesis' || stage === 'publish' ? stage : 'planning';
}

function failedCard(detail: TaskDetail, ref: string, at: string): Card {
  const stage = failedStage(detail, at);
  return {
    kind: 'failure',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    stage,
    code: detail.task.errorCode ?? 'failed',
    message: detail.task.errorMessage ?? 'This task stopped.',
    // eslint-disable-next-line security/detect-object-injection
    knownEffects: KNOWN_EFFECTS[stage],
    recovery: 'retry',
    resolved: detail.task.status !== 'failed',
    missing: [],
    inboxRef: ref,
  };
}

function uncertainCard(detail: TaskDetail, ref: string): Card {
  return {
    kind: 'failure',
    taskId: detail.task.id,
    taskTitle: detail.task.title,
    stage: 'action',
    code: detail.task.errorCode ?? 'outcome_uncertain',
    message: detail.task.errorMessage ?? 'Google Docs did not confirm the write.',
    knownEffects: 'A document may exist. Reconcile before retrying; it is never created twice.',
    recovery: 'reconcile',
    resolved: detail.task.status !== 'outcome_uncertain',
    missing: [],
    inboxRef: ref,
  };
}

type Anchored = { readonly ref: string; readonly card: Card };

type DecisionBuilder = (
  detail: TaskDetail,
  ref: string,
  names: Names,
  now: string,
  at: string,
) => Card | undefined;

/** Decision anchors by ref prefix; the ref is the same string the inbox row carries. */
const DECISIONS: readonly (readonly [string, DecisionBuilder])[] = [
  ['plan:', (detail, ref) => planCard(detail, ref)],
  ['question:', (detail, ref, names) => questionCard(detail, ref, names)],
  ['missing:', (detail, ref, names) => missingCard(detail, ref, names)],
  ['approval:', (detail, ref, _names, now) => approvalCard(detail, ref, now)],
  ['failed:', (detail, ref, _names, _now, at) => failedCard(detail, ref, at)],
  ['uncertain:', (detail, ref) => uncertainCard(detail, ref)],
];

function resultAnchor(message: MessageView, detail: TaskDetail, ref: string | undefined) {
  const revision = ref?.startsWith('revision:')
    ? Number(ref.slice('revision:'.length))
    : revisionAt(detail, message.at);
  if (revision === undefined) return undefined;
  const result = resultCard(detail, revision);
  return result === undefined ? undefined : { ref: `revision:${revision}`, card: result };
}

/** The card a persisted anchor row stands for right now, or undefined when the state is gone. */
function anchoredCard(
  message: MessageView,
  detail: TaskDetail,
  names: Names,
  now: string,
): Anchored | undefined {
  const card = message.card;
  if (card === null) return undefined;
  if (card.kind === 'task_created') return { ref: 'live', card: runningCard(detail, names) };
  if (card.kind === 'result_ready') return resultAnchor(message, detail, card.ref);
  const ref = card.ref;
  if (ref === undefined) return undefined;
  const build = DECISIONS.find(([prefix]) => ref.startsWith(prefix))?.[1];
  const derived = build?.(detail, ref, names, now, message.at);
  return derived === undefined ? undefined : { ref, card: derived };
}

const systemItem = (message: MessageView): TimelineItem => ({
  kind: 'system',
  id: `msg:${message.id}`,
  at: message.at,
  messageId: message.id,
  text: message.text,
  taskId: message.taskId,
});

function contributionItem(detail: TaskDetail, a: AssignmentView, names: Names): TimelineItem {
  return {
    kind: 'contribution',
    id: `asg:${a.id}`,
    at: a.finishedAt ?? a.deadlineAt,
    taskId: detail.task.id,
    assignmentId: a.id,
    author: teammateAuthor(names, a.teammateId, a.teammateName),
    status: a.status,
    summary: a.output?.summary ?? null,
    statements: a.output?.statements.length ?? 0,
    question: a.question,
    error: a.errorMessage,
  };
}

function dedupe(input: TimelineInput) {
  const messages = new Map<string, MessageView>();
  for (const message of input.messages) messages.set(message.id, message);
  const tasks = new Map<string, TaskDetail>();
  for (const detail of input.tasks) {
    const held = tasks.get(detail.task.id);
    if (held === undefined || held.task.version <= detail.task.version)
      tasks.set(detail.task.id, detail);
  }
  const names = new Map<string, string>([[input.teammate.id, input.teammate.name]]);
  for (const teammate of input.teammates ?? []) names.set(teammate.id, teammate.name);
  for (const detail of tasks.values())
    for (const a of detail.assignments) names.set(a.teammateId, a.teammateName);
  return { messages, tasks, names };
}

const messageItem = (message: MessageView, teammate: TimelineInput['teammate']): TimelineItem =>
  message.role === 'system'
    ? systemItem(message)
    : {
        kind: 'message',
        id: `msg:${message.id}`,
        at: message.at,
        messageId: message.id,
        author: authorOf(message, teammate),
        text: message.text,
        grouped: false,
        pending: message.pending,
        taskId: message.taskId,
      };

/** Sort position: timestamp, then the source row id so equal timestamps stay in insertion order. */
type Placed = { readonly item: TimelineItem; readonly seq: string };

function placeMessages(
  input: TimelineInput,
  messages: Iterable<MessageView>,
  tasks: ReadonlyMap<string, TaskDetail>,
  names: Names,
): Placed[] {
  const placed: Placed[] = [];
  const cards = new Set<string>();
  for (const message of messages) {
    const detail = message.card === null ? undefined : tasks.get(message.card.taskId);
    const anchored =
      detail === undefined ? undefined : anchoredCard(message, detail, names, input.now);
    const id = anchored === undefined ? undefined : `card:${anchored.card.taskId}:${anchored.ref}`;
    // One card per anchor id: a second announcement of the same revision stays a plain row.
    if (id === undefined || anchored === undefined || cards.has(id)) {
      placed.push({
        seq: message.id,
        item: message.card === null ? messageItem(message, input.teammate) : systemItem(message),
      });
      continue;
    }
    cards.add(id);
    placed.push({
      seq: message.id,
      item: { kind: 'card', id, at: message.at, taskId: anchored.card.taskId, card: anchored.card },
    });
  }
  return placed;
}

function place(input: TimelineInput): Placed[] {
  const { messages, tasks, names } = dedupe(input);
  const placed = placeMessages(input, messages.values(), tasks, names);
  for (const detail of tasks.values())
    for (const a of detail.assignments)
      if (CONTRIBUTION_STATUSES.has(a.status) && a.finishedAt !== null)
        placed.push({ seq: a.id, item: contributionItem(detail, a, names) });
  return placed.sort((x, y) => x.item.at.localeCompare(y.item.at) || x.seq.localeCompare(y.seq));
}

/**
 * The conversation as the member reads it: messages, persisted system rows, cards whose content
 * is the task's current state, and specialist contributions, with day separators and grouping.
 * Item ids are stable and content-free, so a poll or reconnect can never duplicate or reorder.
 */
export function timelineItems(input: TimelineInput): readonly TimelineItem[] {
  const dayOf = input.dayOf ?? utcDay;
  const out: TimelineItem[] = [];
  let day: string | undefined;
  let previous: Extract<TimelineItem, { kind: 'message' }> | undefined;
  for (const { item } of place(input)) {
    const itemDay = dayOf(item.at);
    if (itemDay !== day) {
      day = itemDay;
      previous = undefined;
      out.push({ kind: 'day', id: `day:${itemDay}`, at: item.at, date: itemDay });
    }
    if (item.kind !== 'message') {
      previous = undefined;
      out.push(item);
      continue;
    }
    const grouped =
      previous !== undefined &&
      authorKey(previous.author) === authorKey(item.author) &&
      Date.parse(item.at) - Date.parse(previous.at) <= GROUP_WINDOW_MS;
    const message = { ...item, grouped };
    previous = message;
    out.push(message);
  }
  return out;
}
