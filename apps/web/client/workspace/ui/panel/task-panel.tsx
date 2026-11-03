// Task view: assignments with their owners and status, the observed activity collapsed, and the
// member's recovery commands.

import { useState } from 'preact/hooks';

import { resultRoute } from '../../store/panel-routes.js';
import {
  canCancel,
  canReconcile,
  canRetry,
  missingAssignments,
} from '../../store/task-commands.js';
import { clockTime } from '../../store/time.js';
import { AnswerForm } from '../cards/answer-form.jsx';
import {
  ASSIGNMENT_LABEL,
  ASSIGNMENT_TONE,
  Chip,
  ErrorLine,
  STATUS_LABEL,
  Who,
  useCommand,
  useOpen,
} from '../cards/bits.jsx';
import { useWorkspace } from '../context.js';
import { GraphStatus } from '../graph/graph-status.jsx';

import { Facts, TaskGate } from './task-gate.jsx';

import type { TaskDetailPage } from '../../../../shared/contract.js';
import type { PanelRoute } from '../../../../shared/route.js';
import type { JSX } from 'preact';

type TaskRoute = Extract<PanelRoute, { kind: 'task' }>;

function Commands(props: { readonly detail: TaskDetailPage }): JSX.Element | null {
  const { detail } = props;
  const command = useCommand(detail.task.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = detail.task.status;
  const missing = missingAssignments(detail);
  const ids = missing.map((a) => a.id);
  const none =
    !canCancel(status) && !canRetry(status) && !canReconcile(status) && missing.length === 0;
  if (none) return null;
  return (
    <div class="pn-decide">
      {missing.length === 0 ? null : (
        <>
          <p class="note" role="status">
            {missing.length} contribution{missing.length === 1 ? '' : 's'} did not finish. Retry
            them, or proceed and let the result state the gap.
          </p>
          <div class="pn-actions">
            <button
              type="button"
              class="btn btn-primary"
              disabled={command.busy}
              onClick={() => void command.run('missing', { decision: 'retry', assignmentIds: ids })}
            >
              Retry
            </button>
            <button
              type="button"
              class="btn"
              disabled={command.busy}
              onClick={() =>
                void command.run('missing', { decision: 'proceed', assignmentIds: ids })
              }
            >
              Proceed with what finished
            </button>
          </div>
        </>
      )}
      <div class="pn-actions">
        {canRetry(status) ? (
          <button
            type="button"
            class="btn btn-primary"
            disabled={command.busy}
            onClick={() => void command.run('retry')}
          >
            Retry the failed step
          </button>
        ) : null}
        {canReconcile(status) ? (
          <button
            type="button"
            class="btn btn-primary"
            disabled={command.busy}
            onClick={() => void command.run('reconcile')}
          >
            Reconcile
          </button>
        ) : null}
        {canCancel(status) && !confirmCancel ? (
          <button
            type="button"
            class="btn btn-quiet"
            disabled={command.busy}
            onClick={() => setConfirmCancel(true)}
          >
            Cancel task
          </button>
        ) : null}
        {confirmCancel ? (
          <>
            <span>Stop this task? Nothing more runs and nothing is published.</span>
            <button
              type="button"
              class="btn btn-primary"
              disabled={command.busy}
              onClick={() => void command.run('cancel').then(() => setConfirmCancel(false))}
            >
              Yes, cancel it
            </button>
            <button type="button" class="btn btn-quiet" onClick={() => setConfirmCancel(false)}>
              Keep running
            </button>
          </>
        ) : null}
      </div>
      <ErrorLine text={command.error} />
    </div>
  );
}

export function TaskPanel(props: { readonly panel: TaskRoute }): JSX.Element {
  const { store } = useWorkspace();
  const open = useOpen();
  return (
    <TaskGate taskId={props.panel.taskId}>
      {(detail) => {
        const { task } = detail;
        const live = detail.assignments.filter((a) => a.status !== 'superseded');
        return (
          <div class="task">
            <header class="rp-head">
              <h3 class="rp-title">{task.title}</h3>
              <p class="rp-meta">
                <Chip
                  tone={
                    task.status === 'failed' || task.status === 'outcome_uncertain'
                      ? 'error'
                      : task.status === 'completed' || task.status === 'ready'
                        ? 'ok'
                        : 'segment'
                  }
                >
                  {STATUS_LABEL[task.status]}
                </Chip>
                <span class="muted">
                  {task.mode} · {task.workflow.replaceAll('_', ' ')}
                </span>
              </p>
            </header>
            {task.errorMessage === null ? null : (
              <p class="note" data-tone="error" role="status">
                {task.errorMessage}
              </p>
            )}
            <Facts
              rows={[
                ['Question', detail.scope.question],
                ['Owner', <Who id={task.resultOwner} name="Result owner" size={20} />],
                [
                  'Result',
                  task.latestRevision === 0 ? (
                    'none yet'
                  ) : (
                    <button
                      type="button"
                      class="link"
                      onClick={(event) =>
                        open(resultRoute(store.peek().route, task.id, task.latestRevision), event)
                      }
                    >
                      Open revision {task.latestRevision}
                    </button>
                  ),
                ],
              ]}
            />
            <GraphStatus taskId={task.id} />
            <h4>Assignments</h4>
            {live.length === 0 ? <p class="muted">No assignments yet.</p> : null}
            <ul class="asg-list">
              {live.map((a) => (
                <li key={a.id} class="asg">
                  <div class="asg-head">
                    <Who id={a.teammateId} name={a.teammateName} size={24} />
                    <Chip tone={ASSIGNMENT_TONE[a.status]}>{ASSIGNMENT_LABEL[a.status]}</Chip>
                    {a.attempt > 1 ? <span class="muted">attempt {a.attempt}</span> : null}
                  </div>
                  <p class="asg-brief">{a.brief}</p>
                  {a.question !== null && a.status === 'needs_input' ? (
                    <>
                      <p class="ctb-question">Asked: {a.question}</p>
                      <AnswerForm id={`asg-${a.id}`} taskId={task.id} assignmentId={a.id} />
                    </>
                  ) : null}
                  {a.errorMessage !== null ? <p class="ctb-error">{a.errorMessage}</p> : null}
                </li>
              ))}
            </ul>
            <details class="activity">
              <summary>Activity ({detail.events.length})</summary>
              <ol class="events">
                {detail.events.map((e) => (
                  <li key={e.seq}>
                    <time dateTime={e.at}>{clockTime(e.at)}</time>
                    <span class="muted">{e.type}</span> {e.summary}
                  </li>
                ))}
              </ol>
            </details>
            <Commands detail={detail} />
          </div>
        );
      }}
    </TaskGate>
  );
}
