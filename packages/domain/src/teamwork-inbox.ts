import type { AssignmentStatus, InboxKind, TeamworkStatus } from './teamwork.js';

export type InboxSnapshot = {
  readonly status: TeamworkStatus;
  readonly planVersion: number | null;
  readonly latestRevision: number;
  readonly version: number;
  readonly assignments: readonly {
    readonly id: string;
    readonly key: string;
    readonly status: AssignmentStatus;
    readonly attempt: number;
    readonly question: string | null;
  }[];
  readonly pendingApproval: { readonly id: string } | null;
  readonly publishedApproval: { readonly id: string } | null;
};

export type DesiredItem = {
  readonly kind: InboxKind;
  readonly ref: string;
  readonly summary: string;
};

type ItemsFor = (snapshot: InboxSnapshot) => readonly DesiredItem[];

const questions: ItemsFor = (snapshot) =>
  snapshot.assignments
    .filter((assignment) => assignment.status === 'needs_input')
    .map((assignment) => ({
      kind: 'question',
      ref: `question:${assignment.id}:${assignment.attempt}`,
      summary: assignment.question ?? `${assignment.key} needs more information.`,
    }));

const missingContributions: ItemsFor = (snapshot) => {
  const missing = snapshot.assignments.filter((assignment) =>
    ['failed', 'timed_out'].includes(assignment.status),
  );
  if (missing.length === 0) return [];
  return [
    {
      kind: 'question',
      ref: `missing:${missing.map((a) => `${a.id}.${a.attempt}`).join(',')}`,
      summary: `${missing.length} contribution${missing.length === 1 ? '' : 's'} did not finish. Retry, or continue with the limitation stated.`,
    },
  ];
};

const ITEMS_BY_STATUS: Record<TeamworkStatus, ItemsFor> = {
  plan_review: (snapshot) => [
    {
      kind: 'plan_review',
      ref: `plan:${snapshot.planVersion ?? 0}`,
      summary: `Review the coordinator's plan (version ${snapshot.planVersion ?? 0}) before any work starts.`,
    },
  ],
  needs_input: (snapshot) => [...questions(snapshot), ...missingContributions(snapshot)],
  ready: (snapshot) => [
    {
      kind: 'completed',
      ref: `revision:${snapshot.latestRevision}`,
      summary: `Result ready for review (revision ${snapshot.latestRevision}).`,
    },
  ],
  awaiting_action_approval: (snapshot) =>
    snapshot.pendingApproval === null
      ? []
      : [
          {
            kind: 'approval',
            ref: `approval:${snapshot.pendingApproval.id}`,
            summary: 'Approve or reject publishing this exact revision to Google Docs.',
          },
        ],
  failed: (snapshot) => [
    {
      kind: 'failed',
      ref: `failed:${snapshot.version}`,
      summary: 'This task stopped. Open it to see what happened and how to recover.',
    },
  ],
  outcome_uncertain: (snapshot) => [
    {
      kind: 'uncertain',
      ref: `uncertain:${snapshot.version}`,
      summary:
        'Google Docs did not confirm the write. Check before retrying; it will not be created twice.',
    },
  ],
  completed: (snapshot) =>
    snapshot.publishedApproval === null
      ? []
      : [
          {
            kind: 'completed',
            ref: `published:${snapshot.publishedApproval.id}`,
            summary: 'Published to Google Docs.',
          },
        ],
  planning: questions,
  running: questions,
  synthesizing: questions,
  publishing: questions,
  declined: questions,
  cancel_requested: questions,
  cancelled: questions,
};

/**
 * The open inbox items a task should have right now. The service upserts these and resolves
 * every other open item for the task in the same transaction as the state change, so the inbox,
 * task page and conversation can never disagree about what still needs the member.
 */
export function desiredInbox(snapshot: InboxSnapshot): readonly DesiredItem[] {
  return ITEMS_BY_STATUS[snapshot.status](snapshot);
}

/** Inbox kinds that get a persisted card in the conversation; `completed` already has `result_ready`. */
export const CARD_KINDS = ['question', 'plan_review', 'approval', 'failed', 'uncertain'] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type CardAnchor = {
  readonly kind: CardKind;
  /** Short factual body of the anchor row; the card itself is derived from task state. */
  readonly text: string;
  readonly clientRequestId: string;
};

const CARD_TEXT: Record<CardKind, (ref: string) => string> = {
  plan_review: (ref) => `Plan v${ref.slice('plan:'.length)} needs your review`,
  question: (ref) =>
    ref.startsWith('missing:')
      ? `${ref.slice('missing:'.length).split(',').length} contribution(s) did not finish`
      : 'A teammate needs your answer',
  approval: () => 'Publishing needs your approval',
  failed: () => 'This task stopped',
  uncertain: () => 'Publishing outcome is uncertain',
};

/**
 * The conversation row a newly desired inbox item anchors, or null for informational items. The
 * client request id is one per task and ref, so re-running the sync cannot post a second row.
 */
export function cardAnchor(taskId: string, item: DesiredItem): CardAnchor | null {
  const kind = (CARD_KINDS as readonly string[]).includes(item.kind)
    ? (item.kind as CardKind)
    : null;
  if (kind === null) return null;
  // eslint-disable-next-line security/detect-object-injection
  return { kind, text: CARD_TEXT[kind](item.ref), clientRequestId: `card:${taskId}:${item.ref}` };
}
