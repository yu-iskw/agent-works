// Plan review: the exact version with its assignments, capabilities and boundary, and the
// decision that posts the version and digest the member is looking at.

import { useState } from 'preact/hooks';

import { pages } from '../../../../shared/contract.js';
import { planDecisionBlocker } from '../../store/task-commands.js';
import { Chip, ErrorLine, Who, sourceLabel, useCommand } from '../cards/bits.jsx';
import { useWorkspace } from '../context.js';

import { Facts, TaskGate } from './task-gate.jsx';

import type { TaskDetailPage } from '../../../../shared/contract.js';
import type { PanelRoute } from '../../../../shared/route.js';
import type { PlanView } from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

type PlanRoute = Extract<PanelRoute, { kind: 'plan' }>;

const STATE_LABEL: Readonly<Record<PlanView['state'], string>> = {
  proposed: 'Pending your review',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

function Assignments(props: { readonly detail: TaskDetailPage; readonly plan: PlanView }) {
  const named = new Map(props.detail.assignments.map((a) => [a.teammateId, a.teammateName]));
  return (
    <ol class="plan-asg">
      {props.plan.content.assignments.map((a) => (
        <li key={a.key}>
          <div class="plan-asg-head">
            <Who id={a.teammateId} name={named.get(a.teammateId) ?? 'Specialist'} size={28} />
            <span class="muted">{a.key}</span>
          </div>
          <p class="plan-brief">{a.brief}</p>
          <Facts
            rows={[
              ['Deliverable', a.deliverable],
              ['Sources', a.sources.map(sourceLabel).join(', ')],
              ['Depends on', a.dependsOn.length === 0 ? 'nothing' : a.dependsOn.join(', ')],
            ]}
          />
        </li>
      ))}
    </ol>
  );
}

function Decision(props: {
  readonly detail: TaskDetailPage;
  readonly plan: PlanView;
}): JSX.Element {
  const { detail, plan } = props;
  const command = useCommand(detail.task.id);
  const [feedback, setFeedback] = useState('');
  const [replanning, setReplanning] = useState(false);
  const blocker = planDecisionBlocker(detail, plan.version);
  const disabled = blocker !== null || command.busy;
  const decide = (decision: 'approve' | 'reject') =>
    void command.run('plan/decision', {
      version: plan.version,
      expectedDigest: plan.digest,
      decision,
    });
  return (
    <div class="pn-decide">
      {blocker === null ? null : (
        <p class="note" role="status">
          {blocker}
        </p>
      )}
      <div class="pn-actions">
        <button
          type="button"
          class="btn btn-primary"
          disabled={disabled}
          onClick={() => decide('approve')}
        >
          Approve plan v{plan.version}
        </button>
        <button type="button" class="btn" disabled={disabled} onClick={() => decide('reject')}>
          Reject
        </button>
        <button
          type="button"
          class="btn btn-quiet"
          disabled={disabled}
          aria-expanded={replanning}
          onClick={() => setReplanning((v) => !v)}
        >
          Replan with feedback
        </button>
      </div>
      {replanning ? (
        <form
          class="replan"
          onSubmit={(event) => {
            event.preventDefault();
            if (feedback.trim() === '') return;
            void command.run('plan/replan', { feedback: feedback.trim() }).then((outcome) => {
              if (outcome.ok) setReplanning(false);
            });
          }}
        >
          <label for="replan-feedback">What should change in the plan?</label>
          <textarea
            id="replan-feedback"
            rows={3}
            value={feedback}
            onInput={(event) => setFeedback(event.currentTarget.value)}
          />
          <button type="submit" class="btn btn-primary btn-sm" disabled={disabled}>
            Ask for a new plan
          </button>
        </form>
      ) : null}
      <ErrorLine text={command.error} />
    </div>
  );
}

export function PlanPanel(props: { readonly panel: PlanRoute }): JSX.Element {
  const { store } = useWorkspace();
  const segment = store.state.value.scope.segment;
  const { panel } = props;
  return (
    <TaskGate taskId={panel.taskId}>
      {(detail) => {
        const plan = detail.plans.find((p) => p.version === panel.version);
        if (plan === undefined)
          return <p role="alert">Plan version {panel.version} is not available for this task.</p>;
        const effects = plan.content.expectedEffects;
        return (
          <div class="plan">
            <header class="rp-head">
              <h3 class="rp-title">{detail.task.title}</h3>
              <p class="rp-meta">
                <Chip tone={plan.state === 'proposed' ? 'attention' : 'muted'}>
                  Version {plan.version} · {STATE_LABEL[plan.state]}
                </Chip>
                <span class="muted">by {plan.author}</span>
              </p>
            </header>
            <p class="card-text">{plan.content.summary}</p>
            <h4>Assignments</h4>
            <Assignments detail={detail} plan={plan} />
            <h4>Capabilities this plan would use</h4>
            {plan.capabilities.length === 0 ? (
              <p class="muted">None beyond reading the task's sources.</p>
            ) : (
              <ul class="plain">
                {plan.capabilities.map((c) => (
                  <li key={c}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            )}
            <h4>Approval boundary</h4>
            <div class="boundary">
              {effects.length === 0 ? (
                <p>
                  <strong>No external changes.</strong> Approving dispatches the specialists;
                  nothing is written outside this workspace. Publishing needs its own approval
                  later.
                </p>
              ) : (
                <ul>
                  {effects.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              )}
            </div>
            <p class="muted">
              Edit the assignments on the{' '}
              <a href={pages.task(segment, detail.task.id)}>task page</a>; it creates version{' '}
              {plan.version + 1}.
            </p>
            <Decision detail={detail} plan={plan} />
          </div>
        );
      }}
    </TaskGate>
  );
}
