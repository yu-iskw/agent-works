// Small pieces shared by the cards and the review panels: status words, chips, the frame every
// card sits in, and the hooks that open a panel or run a task command.

import { useState } from 'preact/hooks';

import { teammateById } from '../../store/selectors.js';
import { Avatar, initialsOf } from '../avatars.jsx';
import { useWorkspace } from '../context.js';
import { rememberInvoker } from '../panel/invoker.js';

import type { TaskCommand } from '../../../../shared/contract.js';
import type { Route } from '../../../../shared/route.js';
import type { CommandOutcome } from '../../store/task-effects.js';
import type { AssignmentStatus, SourceKind, TeamworkStatus } from '@agent-works/domain/teamwork';
import type { Stage } from '@agent-works/domain/teamwork-timeline';
import type { ComponentChildren, JSX } from 'preact';

export type Tone = 'ok' | 'attention' | 'error' | 'muted' | 'segment';

export const STATUS_LABEL: Readonly<Record<TeamworkStatus, string>> = {
  planning: 'Planning',
  plan_review: 'Plan needs your review',
  running: 'Running',
  needs_input: 'Needs your input',
  synthesizing: 'Writing the result',
  ready: 'Result ready',
  awaiting_action_approval: 'Action needs your approval',
  publishing: 'Publishing',
  completed: 'Completed',
  outcome_uncertain: 'Outcome uncertain',
  failed: 'Failed',
  declined: 'Declined',
  cancel_requested: 'Cancelling',
  cancelled: 'Cancelled',
};

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  ...STATUS_LABEL,
  queued: 'Queued',
  reading: 'Reading sources',
  contributing: 'Specialists are writing',
};

export const ASSIGNMENT_LABEL: Readonly<Record<AssignmentStatus, string>> = {
  queued: 'Queued',
  running: 'Working',
  needs_input: 'Needs input',
  succeeded: 'Done',
  failed: 'Failed',
  timed_out: 'Timed out',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
};

export const ASSIGNMENT_TONE: Readonly<Record<AssignmentStatus, Tone>> = {
  queued: 'muted',
  running: 'segment',
  needs_input: 'attention',
  succeeded: 'ok',
  failed: 'error',
  timed_out: 'error',
  cancelled: 'muted',
  superseded: 'muted',
};

const SOURCE_LABEL: Readonly<Record<SourceKind, string>> = {
  drive_research: 'Research documents',
  drive_context: 'Context documents',
  bigquery_metrics: 'Metrics warehouse',
  github_issue: 'GitHub issue',
  github_code: 'Repository code',
  member_file: 'Your file',
};

/** `kind` is the closed SourceKind enum. */
// eslint-disable-next-line security/detect-object-injection
export const sourceLabel = (kind: SourceKind): string => SOURCE_LABEL[kind];

export function Chip(props: {
  readonly tone: Tone;
  readonly children: ComponentChildren;
}): JSX.Element {
  return (
    <span class="chip" data-tone={props.tone}>
      {props.children}
    </span>
  );
}

/** Teammate identity as the sidebar knows it; initials when the teammate is gone. */
export function Who(props: {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
}): JSX.Element {
  const { store } = useWorkspace();
  const row = teammateById(store.state.value, props.id);
  const size = props.size ?? 24;
  return (
    <span class="who">
      {row === undefined ? (
        <span
          class="avatar"
          data-accent="slate"
          role="img"
          aria-label={props.name}
          style={{
            width: `${size}px`,
            height: `${size}px`,
            fontSize: `${Math.round(size * 0.38)}px`,
          }}
        >
          <span aria-hidden="true">{initialsOf(props.name)}</span>
        </span>
      ) : (
        <Avatar appearance={row.appearance} id={row.id} name={row.name} size={size} />
      )}
      <span class="who-name">{row?.name ?? props.name}</span>
    </span>
  );
}

/** Navigates to a panel route and remembers the control that asked, for focus return on close. */
export function useOpen(): (route: Route, event?: Event) => void {
  const { effects } = useWorkspace();
  return (route, event) => {
    rememberInvoker(event?.currentTarget);
    effects.open(route);
  };
}

export type Command = {
  readonly run: (command: TaskCommand, body?: unknown) => Promise<CommandOutcome>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly clearError: () => void;
};

/** One in-flight command per control group; the error text is the segment's refusal explained. */
export function useCommand(taskId: string): Command {
  const { effects } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return {
    busy,
    error,
    clearError: () => setError(null),
    run: async (command, body) => {
      if (busy) return { ok: false, code: 'busy', text: 'Still working on the last action.' };
      setBusy(true);
      setError(null);
      const outcome = await effects.tasks.command(taskId, command, body);
      setBusy(false);
      if (!outcome.ok) setError(outcome.text);
      return outcome;
    },
  };
}

export function CardFrame(props: {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly tone: Tone;
  readonly status?: ComponentChildren;
  readonly title: string;
  readonly children?: ComponentChildren;
  readonly actions?: ComponentChildren;
}): JSX.Element {
  return (
    <li class="card" data-kind={props.kind} id={props.id}>
      <article aria-labelledby={`${props.id}-title`}>
        <header class="card-head">
          <span class="card-label" data-tone={props.tone}>
            {props.label}
          </span>
          {props.status === undefined ? null : <span class="card-status">{props.status}</span>}
        </header>
        <h3 class="card-title" id={`${props.id}-title`}>
          {props.title}
        </h3>
        {props.children === undefined ? null : <div class="card-body">{props.children}</div>}
        {props.actions === undefined ? null : <div class="card-actions">{props.actions}</div>}
      </article>
    </li>
  );
}

export function ErrorLine(props: { readonly text: string | null }): JSX.Element | null {
  return props.text === null ? null : (
    <p class="cmd-error" role="alert">
      {props.text}
    </p>
  );
}
