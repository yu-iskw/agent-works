// One component per card kind. Each card shows what §4.3 names inline and hands the rest to its
// panel; nothing here repeats the task page.

import { approvalRoute, planRoute, resultRoute, taskRoute } from '../../store/panel-routes.js';
import { useWorkspace } from '../context.js';

import { AnswerForm } from './answer-form.jsx';
import {
  ASSIGNMENT_LABEL,
  CardFrame,
  Chip,
  ErrorLine,
  STAGE_LABEL,
  Who,
  useCommand,
  useOpen,
} from './bits.jsx';

import type { Card, Stage, TimelineItem } from '@agent-works/domain/teamwork-timeline';
import type { JSX } from 'preact';

type Item = Extract<TimelineItem, { kind: 'card' }>;
type Of<K extends Card['kind']> = Extract<Card, { kind: K }>;

const NEXT_ACTION: Readonly<Record<Stage, string>> = {
  planning: 'The coordinator is drafting a plan.',
  plan_review: 'Review the plan to start the work.',
  queued: 'Waiting for a worker to pick it up.',
  reading: 'Specialists are reading their sources.',
  contributing: 'Specialists are writing their contributions.',
  needs_input: 'Answer the open question to continue.',
  synthesizing: 'The result owner is writing the result.',
  ready: 'Open the result.',
  awaiting_action_approval: 'Review the pending action.',
  publishing: 'Publishing the approved document.',
  completed: 'Nothing left to do.',
  outcome_uncertain: 'Reconcile the publish before anything else.',
  failed: 'Retry the failed step.',
  declined: 'The plan was declined.',
  cancel_requested: 'Finishing the current step, then stopping.',
  cancelled: 'Nothing more will run.',
};

function RunningCard(props: { readonly item: Item; readonly card: Of<'running'> }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { card, item } = props;
  const live = card.stage === 'queued' || card.stage === 'reading' || card.stage === 'contributing';
  return (
    <CardFrame
      id={item.id}
      kind="running"
      label="Work"
      tone={live ? 'segment' : 'muted'}
      status={<Chip tone={live ? 'segment' : 'muted'}>{STAGE_LABEL[card.stage]}</Chip>}
      title={card.taskTitle}
      actions={
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          onClick={(event) => open(taskRoute(store.peek().route, card.taskId), event)}
        >
          Open task
        </button>
      }
    >
      <dl class="card-facts">
        <div>
          <dt>Owner</dt>
          <dd>
            {card.owner.kind === 'teammate' ? (
              <Who id={card.owner.id} name={card.owner.name} size={20} />
            ) : (
              'You'
            )}
          </dd>
        </div>
        <div>
          <dt>Contributions</dt>
          <dd>
            {card.done} of {card.total} done
          </dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>{NEXT_ACTION[card.stage]}</dd>
        </div>
      </dl>
    </CardFrame>
  );
}

function QuestionCard(props: { readonly item: Item; readonly card: Of<'question'> }): JSX.Element {
  const { card, item } = props;
  return (
    <CardFrame
      id={item.id}
      kind="question"
      label="Question"
      tone={card.answered ? 'muted' : 'attention'}
      status={
        <Chip tone={card.answered ? 'ok' : 'attention'}>
          {card.answered ? 'Answered' : 'Needs your answer'}
        </Chip>
      }
      title={card.taskTitle}
    >
      <p class="card-who">
        <Who id={card.author.id} name={card.author.name} size={20} /> asks
      </p>
      <p class="card-question">{card.question}</p>
      {card.answered ? null : (
        <AnswerForm id={item.id} taskId={card.taskId} assignmentId={card.assignmentId} />
      )}
    </CardFrame>
  );
}

const PLAN_STATE: Readonly<Record<Of<'plan'>['state'], string>> = {
  proposed: 'Pending your review',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Replaced by a newer version',
};

function PlanCard(props: { readonly item: Item; readonly card: Of<'plan'> }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { card, item } = props;
  const pending = card.state === 'proposed';
  return (
    <CardFrame
      id={item.id}
      kind="plan"
      label={`Plan v${card.version}`}
      tone={pending ? 'attention' : 'muted'}
      status={<Chip tone={pending ? 'attention' : 'muted'}>{PLAN_STATE[card.state]}</Chip>}
      title={card.taskTitle}
      actions={
        <button
          type="button"
          class={pending ? 'btn btn-primary btn-sm' : 'btn btn-quiet btn-sm'}
          onClick={(event) => open(planRoute(store.peek().route, card.taskId, card.version), event)}
        >
          Review plan
        </button>
      }
    >
      <p class="card-text">{card.summary}</p>
      <p class="muted">
        {card.assignments} assignment{card.assignments === 1 ? '' : 's'}
      </p>
    </CardFrame>
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function Counts(props: { readonly unsupported: number; readonly limitations: number }) {
  const parts = [
    ...(props.unsupported > 0 ? [plural(props.unsupported, 'unsupported statement')] : []),
    ...(props.limitations > 0 ? [plural(props.limitations, 'limitation')] : []),
  ];
  return parts.length === 0 ? null : <p class="muted">{parts.join(' · ')}</p>;
}

function ResultCard(props: { readonly item: Item; readonly card: Of<'result'> }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { card, item } = props;
  const old = card.latest > card.revision;
  return (
    <CardFrame
      id={item.id}
      kind="result"
      label="Result"
      tone="ok"
      status={
        <Chip tone={old ? 'muted' : 'ok'}>
          Revision {card.revision}
          {old ? ` of ${card.latest}` : ''}
        </Chip>
      }
      title={card.title}
      actions={
        <>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            onClick={(event) =>
              open(resultRoute(store.peek().route, card.taskId, card.revision), event)
            }
          >
            Open result
          </button>
          {old ? (
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              onClick={(event) =>
                open(resultRoute(store.peek().route, card.taskId, card.latest), event)
              }
            >
              Newer: revision {card.latest}
            </button>
          ) : null}
        </>
      }
    >
      <p class="card-text">{card.summary}</p>
      <Counts unsupported={card.unsupported} limitations={card.limitations} />
    </CardFrame>
  );
}

const INVALID: Readonly<Record<NonNullable<Of<'approval'>['invalidReason']>, string>> = {
  decided: 'Already decided',
  stale_revision: 'A newer revision exists; this approval cannot write it',
  expired: 'Expired before a decision',
};

function ApprovalCard(props: { readonly item: Item; readonly card: Of<'approval'> }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { card, item } = props;
  return (
    <CardFrame
      id={item.id}
      kind="approval"
      label="Action approval"
      tone={card.valid ? 'attention' : 'muted'}
      status={
        card.valid ? (
          <Chip tone="attention">Pending your approval</Chip>
        ) : (
          <Chip tone={card.invalidReason === 'decided' ? 'muted' : 'error'}>
            {card.invalidReason === null ? 'Invalid' : INVALID[card.invalidReason]}
          </Chip>
        )
      }
      title={card.taskTitle}
      actions={
        <button
          type="button"
          class={card.valid ? 'btn btn-primary btn-sm' : 'btn btn-quiet btn-sm'}
          onClick={(event) =>
            open(approvalRoute(store.peek().route, card.taskId, card.approvalId), event)
          }
        >
          Review action
        </button>
      }
    >
      <dl class="card-facts">
        <div>
          <dt>Operation</dt>
          <dd>Create a document</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{card.account}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>{card.destination}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd>
            {card.revision}
            {card.latestRevision > card.revision ? ` (latest is ${card.latestRevision})` : ''}
          </dd>
        </div>
      </dl>
    </CardFrame>
  );
}

const FAILURE_LABEL: Readonly<Record<Of<'failure'>['stage'], string>> = {
  planning: 'Planning failed',
  synthesis: 'Writing the result failed',
  publish: 'Publishing failed',
  assignment: 'Contributions missing',
  action: 'Outcome uncertain',
};

function Recovery(props: { readonly card: Of<'failure'> }): JSX.Element | null {
  const { card } = props;
  const command = useCommand(card.taskId);
  if (card.resolved || card.recovery === 'none') return null;
  const ids = card.missing.map((m) => m.assignmentId);
  return (
    <>
      {card.recovery === 'retry' ? (
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={command.busy}
          onClick={() => void command.run('retry')}
        >
          Retry
        </button>
      ) : null}
      {card.recovery === 'reconcile' ? (
        <button
          type="button"
          class="btn btn-primary btn-sm"
          disabled={command.busy}
          onClick={() => void command.run('reconcile')}
        >
          Reconcile
        </button>
      ) : null}
      {card.recovery === 'decide' ? (
        <>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={command.busy}
            onClick={() => void command.run('missing', { decision: 'retry', assignmentIds: ids })}
          >
            Retry them
          </button>
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            disabled={command.busy}
            onClick={() => void command.run('missing', { decision: 'proceed', assignmentIds: ids })}
          >
            Proceed with what finished
          </button>
        </>
      ) : null}
      <ErrorLine text={command.error} />
    </>
  );
}

function FailureCard(props: { readonly item: Item; readonly card: Of<'failure'> }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  const { card, item } = props;
  return (
    <CardFrame
      id={item.id}
      kind="failure"
      label={FAILURE_LABEL[card.stage]}
      tone={card.resolved ? 'muted' : 'error'}
      status={
        <Chip tone={card.resolved ? 'ok' : 'error'}>{card.resolved ? 'Resolved' : card.code}</Chip>
      }
      title={card.taskTitle}
      actions={
        <>
          <Recovery card={card} />
          <button
            type="button"
            class="btn btn-quiet btn-sm"
            onClick={(event) => open(taskRoute(store.peek().route, card.taskId), event)}
          >
            Open task
          </button>
        </>
      }
    >
      <p class="card-text">{card.message}</p>
      <p class="muted">{card.knownEffects}</p>
      {card.missing.length === 0 ? null : (
        <ul class="card-missing">
          {card.missing.map((m) => (
            <li key={m.assignmentId}>
              <Who id={m.author.id} name={m.author.name} size={20} />
              <span class="muted">{ASSIGNMENT_LABEL[m.status]}</span>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

export function CardItem(props: { readonly item: Item }): JSX.Element {
  const { item } = props;
  const card = item.card;
  switch (card.kind) {
    case 'running':
      return <RunningCard item={item} card={card} />;
    case 'question':
      return <QuestionCard item={item} card={card} />;
    case 'plan':
      return <PlanCard item={item} card={card} />;
    case 'result':
      return <ResultCard item={item} card={card} />;
    case 'approval':
      return <ApprovalCard item={item} card={card} />;
    case 'failure':
      return <FailureCard item={item} card={card} />;
  }
}
