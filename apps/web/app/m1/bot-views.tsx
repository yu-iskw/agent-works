import { h } from '../html.js';

import { Csrf, PageHead, Shell, segPath } from './views.js';

import type { BotDesign, BotPreview, BotRun, BotRunSummary, Conversation } from './api.js';
import type { PageCtx } from './views.js';
import type { Child, Html } from '../html.js';

function Form(props: { ctx: PageCtx; action: string; children?: readonly Child[] }): Html {
  return (
    <form method="post" action={segPath(props.ctx.segment, props.action)}>
      <Csrf session={props.ctx.session} />
      {props.children}
    </form>
  );
}

function stepDetail(step: BotPreview['steps'][number]): string {
  switch (step.kind) {
    case 'connector_read':
      return `Capability: ${step.capability}. Query: ${step.query}.`;
    case 'skill':
      return `Inputs: ${step.inputs.join(', ') || 'none'}.`;
    case 'mcp_delegate':
      return `Agent: ${step.agent.agentId}. Inputs: ${step.inputs.join(', ') || 'none'}. Timeout: ${step.timeoutSeconds} seconds.`;
    case 'approval':
      return `Prompt: ${step.prompt}`;
    case 'result':
      return `Result from: ${step.from}.`;
  }
}

export function Preview(props: { ctx: PageCtx; id: string; preview: BotPreview }): Html {
  const { ctx, id, preview: p } = props;
  return (
    <section class="card panel-body" aria-labelledby="preview-heading">
      <h2 id="preview-heading">Review draft revision {p.revision}</h2>
      <h3>{p.name}</h3>
      <p>{p.purpose}</p>
      <p>{p.planning}</p>
      <p>Digest: {p.digest}</p>
      <h3>Steps and dependencies</h3>
      <ol>
        {p.steps.map((step) => (
          <li>
            <strong>{step.title}</strong> ({step.kind}, {step.id}). Depends on:{' '}
            {step.dependsOn.length ? step.dependsOn.join(', ') : 'none'}. {stepDetail(step)}
          </li>
        ))}
      </ol>
      <h3>Skills</h3>
      {p.skills.length ? (
        <ul>
          {p.skills.map((skill) => (
            <li>
              {skill.name} in {skill.packageId}, version {skill.version}, digest {skill.digest}{' '}
              (step {skill.stepId})
            </li>
          ))}
        </ul>
      ) : (
        <p>None</p>
      )}
      <h3>External agents and data sent externally</h3>
      {p.externalAgents.length ? (
        <ul>
          {p.externalAgents.map((agent) => (
            <li>
              <strong>
                Data sent externally to {agent.displayName} ({agent.agentId})
              </strong>
              :{' '}
              {agent.dataSentExternally
                .map((data) => `${data.title} (${data.stepId})`)
                .join(', ') || 'none'}
              . Instruction: {agent.instruction}
            </li>
          ))}
        </ul>
      ) : (
        <p>None</p>
      )}
      <h3>Triggers</h3>
      <ul>
        {p.triggers.map((trigger) => (
          <li>{trigger.description}</li>
        ))}
      </ul>
      <h3>Approvals</h3>
      <p>Mode: {p.approvals.mode}</p>
      <ul>
        {p.approvals.checkpoints.map((checkpoint) => (
          <li>
            {checkpoint.stepId}: {checkpoint.prompt}
          </li>
        ))}
      </ul>
      <h3>Limits</h3>
      <p>
        Concurrent runs per bot: {p.limits.maxConcurrentRunsPerBot}; per user:{' '}
        {p.limits.maxConcurrentRunsPerUser}; timeout: {p.limits.runTimeoutMinutes} minutes; maximum
        cost: {p.limits.maxCostMicros === null ? 'not set' : `${p.limits.maxCostMicros} micros`}.
      </p>
      <p>
        Capabilities: {p.capabilities.join(', ') || 'none'}. Result destination:{' '}
        {p.result.destination}.
      </p>
      <p>
        <a href={segPath(ctx.segment, `/bots/${id}/revisions/${p.revision}/export`)}>
          Export revision {p.revision}
        </a>
      </p>
      <Form ctx={ctx} action={`/bots/${id}/publish`}>
        <input type="hidden" name="revision" value={p.revision} />
        <input type="hidden" name="digest" value={p.digest} />
        <button class="btn btn-primary" type="submit">
          Confirm and publish this revision
        </button>
      </Form>
    </section>
  );
}

export function BotPage(props: {
  ctx: PageCtx;
  id: string;
  name: string;
  preview?: BotPreview;
  base?: { revision: number; digest: string };
  design?: BotDesign;
  error?: string;
  runs: readonly BotRunSummary[];
  conversation?: Conversation;
  unavailable?: boolean;
}): Html {
  const { ctx, id, preview } = props;
  if (props.unavailable)
    return (
      <Shell ctx={ctx} title="Bot design">
        <PageHead title="Bot workflows unavailable" />
        <p>Bot workflows are not enabled on this segment.</p>
      </Shell>
    );
  return (
    <Shell ctx={ctx} title="Bot design">
      <PageHead title={`Design a bot with ${props.name}`} />
      {props.error === undefined ? null : (
        <div role="alert" class="alert alert-danger">
          {props.error === 'stale_confirmation'
            ? 'This draft changed since you reviewed it. Reload and review the latest draft.'
            : props.error}{' '}
          <a href={segPath(ctx.segment, `/bots/${id}`)}>Reload</a>
        </div>
      )}
      {props.design?.outcome === 'needs_changes' ? (
        <section class="card panel-body">
          <h2>Changes needed</h2>
          <p>{props.design.reply}</p>
          <ul>
            {props.design.diagnostics.map((d) => (
              <li>
                {d.path.join('.') || 'Proposal'}: {d.message} ({d.code})
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section class="card panel-body" aria-labelledby="bot-conversation">
        <h2 id="bot-conversation">Design conversation</h2>
        {props.conversation?.messages.map((message) => (
          <p>
            <strong>{message.role === 'member' ? 'You' : props.name}:</strong> {message.text}
          </p>
        ))}
      </section>
      <section class="card panel-body">
        <h2>Describe what you want</h2>
        <Form ctx={ctx} action={`/bots/${id}/design`}>
          <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
          <input
            type="hidden"
            name="revision"
            value={preview?.revision ?? props.base?.revision ?? ''}
          />
          <input type="hidden" name="digest" value={preview?.digest ?? props.base?.digest ?? ''} />
          <label for="bot-message">Your request</label>
          <textarea id="bot-message" name="message" required maxlength="2000"></textarea>
          <button class="btn btn-primary" type="submit">
            Send design request
          </button>
        </Form>
      </section>
      {preview === undefined ? null : <Preview ctx={ctx} id={id} preview={preview} />}
      <section class="card panel-body">
        <h2>Runs</h2>
        <Form ctx={ctx} action={`/bots/${id}/runs`}>
          <input type="hidden" name="clientRequestId" value={crypto.randomUUID()} />
          <button class="btn" type="submit">
            Start run
          </button>
        </Form>
        <ul>
          {props.runs.map((run) => (
            <li>
              <a href={segPath(ctx.segment, `/bot-runs/${run.taskId}`)}>Run {run.taskId}</a>:{' '}
              {run.status}
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}

export function RunPage(props: { ctx: PageCtx; run: BotRun; error?: string }): Html {
  const { ctx, run } = props;
  const action = `/bot-runs/${run.taskId}`;
  const cost =
    run.cost.completeness === 'partial' ? 'partial — some costs unknown' : run.cost.completeness;
  return (
    <Shell ctx={ctx} title="Bot run">
      <PageHead title="Bot run" />
      <p>
        Status: <strong>{run.status}</strong>
      </p>
      {props.error === undefined ? null : <p role="alert">{props.error}</p>}
      {run.lastError === null ? null : (
        <p role="alert">
          Last error: {run.lastError.message} ({run.lastError.code})
        </p>
      )}
      <section class="card panel-body">
        <h2>Steps</h2>
        <ol>
          {run.steps.map((step) => (
            <li>
              <strong>{step.title}</strong>: {step.status} (attempt {step.attempt}).{' '}
              {step.errorCode ?? ''} {step.terminalReason ?? ''} {step.outputSummary ?? ''}
              {step.external === null ? null : (
                <p>
                  External agent: {step.external.agentId}; status:{' '}
                  {step.external.lastStatus ?? 'unknown'}; cancellation: {step.external.cancel}
                </p>
              )}
              {run.actions.canRetry.includes(step.stepId) ? (
                <Form ctx={ctx} action={`${action}/steps/${step.stepId}/retry`}>
                  <button type="submit">Retry {step.title}</button>
                </Form>
              ) : null}
              {run.actions.canResolve.includes(step.stepId) ? (
                <Form ctx={ctx} action={`${action}/steps/${step.stepId}/resolve`}>
                  <label>
                    Note <input name="note" required maxlength="300" />
                  </label>
                  <button name="outcome" value="succeeded" type="submit">
                    Resolve as succeeded
                  </button>
                  <button name="outcome" value="failed" type="submit">
                    Resolve as failed
                  </button>
                </Form>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
      <section class="card panel-body">
        <h2>Approvals</h2>
        {run.approvals
          .filter((a) => a.state === 'pending')
          .map((approval) => (
            <div>
              <p>{approval.prompt}</p>
              {run.actions.canApprove.includes(approval.id) ? (
                <Form ctx={ctx} action={`${action}/approvals/${approval.id}`}>
                  <input type="hidden" name="actionDigest" value={approval.actionDigest} />
                  <button type="submit" name="decision" value="approve">
                    Approve
                  </button>
                  <button type="submit" name="decision" value="decline">
                    Decline
                  </button>
                </Form>
              ) : null}
            </div>
          ))}
      </section>
      {run.actions.canCancel ? (
        <Form ctx={ctx} action={`${action}/cancel`}>
          <button type="submit">Cancel run</button>
        </Form>
      ) : null}
      <section class="card panel-body">
        <h2>Result</h2>
        <p>{run.result?.text ?? 'No result yet.'}</p>
        <h2>Cost</h2>
        <p>Cost completeness: {cost}.</p>
        <p>
          Estimated:{' '}
          {run.cost.estimatedMicros === null ? 'unknown' : `${run.cost.estimatedMicros} micros`};
          reported:{' '}
          {run.cost.reportedMicros === null ? 'unknown' : `${run.cost.reportedMicros} micros`}.
        </p>
        <p>{run.cost.unknownItems.join(', ')}</p>
      </section>
      <a href={segPath(ctx.segment, `/bots/${run.teammateId}`)}>Back to bot</a>{' '}
      <a href={segPath(ctx.segment, `/bot-runs/${run.taskId}`)}>Refresh run</a>
    </Shell>
  );
}
