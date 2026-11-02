// The task draft card: what the member reviews before work starts. Objective, workflow, mode,
// scope and specialists are editable in place; Edit expands briefs, owner and advanced scope.
// Nothing here is persisted until Start posts the task.

import { useState } from 'preact/hooks';

import { WORKFLOWS, WORKFLOW_LABELS } from '../../../../shared/composer.js';
import {
  completeMetrics,
  defaultOwner,
  draftProblems,
  sourceOptions,
  synthesisOwners,
} from '../../store/composer-routing.js';
import { useWorkspace } from '../context.js';

import { CardFrame, ErrorLine, Who } from './bits.jsx';

import type { ComposerContext, Specialist, TaskDraft } from '../../../../shared/composer.js';
import type { MetricsScope, SourceKind } from '@agent-works/domain/teamwork';
import type { JSX } from 'preact';

function SpecialistRow(props: {
  readonly draft: TaskDraft;
  readonly specialist: Specialist;
  readonly context: ComposerContext;
}): JSX.Element {
  const { effects } = useWorkspace();
  const { draft, specialist, context } = props;
  const teammate = context.teammates.find((t) => t.id === specialist.teammateId);
  const options = sourceOptions(
    draft.workflow,
    teammate,
    context.sources,
    draft.attachments.length > 0,
  );
  const setSources = (sources: readonly SourceKind[]) =>
    effects.editTaskDraft({
      specialists: draft.specialists.map((s) => (s === specialist ? { ...s, sources } : s)),
    });
  return (
    <li class="td-spec">
      <div class="td-spec-head">
        <Who id={specialist.teammateId} name={specialist.name} size={28} />
        <span class="muted">{specialist.role}</span>
        <button
          type="button"
          class="btn btn-quiet btn-sm td-spec-x"
          aria-label={`Remove ${specialist.name}`}
          onClick={() => effects.removeSpecialist(specialist.teammateId)}
        >
          Remove
        </button>
      </div>
      <fieldset class="td-sources">
        <legend>Sources for {specialist.name}</legend>
        {options.length === 0 ? <p class="muted">No source applies to this workflow.</p> : null}
        {options.map((option) => {
          const ticked = specialist.sources.includes(option.kind);
          return (
            <label
              key={option.kind}
              class={`td-source${option.disabled === null ? '' : ' td-source-off'}`}
            >
              <input
                type="checkbox"
                checked={ticked}
                disabled={option.disabled !== null}
                aria-describedby={
                  option.disabled === null
                    ? undefined
                    : `td-why-${specialist.teammateId}-${option.kind}`
                }
                onChange={(event) =>
                  setSources(
                    event.currentTarget.checked
                      ? [...specialist.sources, option.kind]
                      : specialist.sources.filter((s) => s !== option.kind),
                  )
                }
              />
              <span>{option.name}</span>
              {option.disabled === null ? null : (
                <span class="td-why" id={`td-why-${specialist.teammateId}-${option.kind}`}>
                  {option.disabled}
                </span>
              )}
            </label>
          );
        })}
      </fieldset>
      {draft.expanded ? (
        <label class="td-field">
          <span>Brief for {specialist.name}</span>
          <textarea
            rows={2}
            value={specialist.brief}
            placeholder="Defaults to the objective"
            onInput={(event) =>
              effects.editTaskDraft({
                specialists: draft.specialists.map((s) =>
                  s === specialist ? { ...s, brief: event.currentTarget.value } : s,
                ),
              })
            }
          />
        </label>
      ) : null}
    </li>
  );
}

function AddSpecialist(props: {
  readonly draft: TaskDraft;
  readonly context: ComposerContext;
}): JSX.Element | null {
  const { effects } = useWorkspace();
  const [open, setOpen] = useState(false);
  const taken = new Set(props.draft.specialists.map((s) => s.teammateId));
  const free = props.context.teammates.filter((t) => !taken.has(t.id));
  if (free.length === 0) return null;
  return (
    <div class="td-add">
      <button
        type="button"
        class="btn btn-sm"
        aria-expanded={open}
        aria-controls="td-add-list"
        onClick={() => setOpen((was) => !was)}
      >
        Add specialist
      </button>
      {open ? (
        <ul id="td-add-list" class="td-add-list" aria-label="Teammates to add">
          {free.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                onClick={() => {
                  effects.addSpecialist(t.id);
                  setOpen(false);
                }}
              >
                <Who id={t.id} name={t.name} size={20} /> <span class="muted">{t.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The months live here while the member types; the draft holds a scope only once complete. */
function MetricsFields(props: { readonly draft: TaskDraft }): JSX.Element {
  const { effects } = useWorkspace();
  const [metrics, setMetrics] = useState<MetricsScope>(
    () => props.draft.metrics ?? { baseline: '', current: '', groupBy: 'region' },
  );
  const set = (patch: Partial<MetricsScope>) => {
    const next = { ...metrics, ...patch };
    setMetrics(next);
    effects.editTaskDraft({ metrics: completeMetrics(next) });
  };
  return (
    <div class="td-grid">
      <label class="td-field">
        <span>Baseline month</span>
        <input
          type="month"
          value={metrics.baseline}
          onInput={(e) => set({ baseline: e.currentTarget.value })}
        />
      </label>
      <label class="td-field">
        <span>Current month</span>
        <input
          type="month"
          value={metrics.current}
          onInput={(e) => set({ current: e.currentTarget.value })}
        />
      </label>
      <label class="td-field">
        <span>Group by</span>
        <select
          value={metrics.groupBy}
          onChange={(e) =>
            set({ groupBy: e.currentTarget.value === 'channel' ? 'channel' : 'region' })
          }
        >
          <option value="region">Region</option>
          <option value="channel">Channel</option>
        </select>
      </label>
    </div>
  );
}

function EngineeringFields(props: {
  readonly draft: TaskDraft;
  readonly context: ComposerContext;
}): JSX.Element {
  const { effects } = useWorkspace();
  return (
    <div class="td-grid">
      <label class="td-field">
        <span>Repository</span>
        <select
          value={props.draft.repository ?? ''}
          onChange={(e) =>
            effects.editTaskDraft({
              repository: e.currentTarget.value === '' ? null : e.currentTarget.value,
            })
          }
        >
          <option value="">Choose…</option>
          {props.context.repositories.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label class="td-field">
        <span>Issue number</span>
        <input
          type="number"
          min={1}
          value={props.draft.issueNumber ?? ''}
          onInput={(e) => {
            const n = Number.parseInt(e.currentTarget.value, 10);
            effects.editTaskDraft({ issueNumber: Number.isInteger(n) && n > 0 ? n : null });
          }}
        />
      </label>
    </div>
  );
}

type Card = { readonly draft: TaskDraft; readonly context: ComposerContext };

/** Re-ticks every specialist's sources for a new workflow and resets the scope fields it needs. */
function workflowPatch(card: Card, workflow: TaskDraft['workflow']): Partial<TaskDraft> {
  const { draft, context } = card;
  const engineering = workflow === 'engineering_proposal';
  return {
    workflow,
    resultOwnerId: defaultOwner(context, workflow, draft.resultOwnerId),
    specialists: draft.specialists.map((s) => ({
      ...s,
      sources: sourceOptions(
        workflow,
        context.teammates.find((t) => t.id === s.teammateId),
        context.sources,
        draft.attachments.length > 0,
      )
        .filter((o) => o.disabled === null)
        .map((o) => o.kind),
    })),
    repository: engineering ? (draft.repository ?? context.repositories.at(0) ?? null) : null,
    issueNumber: engineering ? (draft.issueNumber ?? context.issue) : null,
    metrics: workflow === 'metrics_explanation' ? draft.metrics : null,
  };
}

function WorkflowAndMode(props: Card): JSX.Element {
  const { effects } = useWorkspace();
  const { draft } = props;
  return (
    <div class="td-grid">
      <label class="td-field">
        <span>Workflow</span>
        <select
          value={draft.workflow}
          onChange={(event) => {
            const workflow = WORKFLOWS.find((w) => w === event.currentTarget.value);
            if (workflow !== undefined) effects.editTaskDraft(workflowPatch(props, workflow));
          }}
        >
          {WORKFLOWS.map((w) => (
            <option key={w} value={w}>
              {
                // `w` ranges over the closed workflow list.
                // eslint-disable-next-line security/detect-object-injection
                WORKFLOW_LABELS[w]
              }
            </option>
          ))}
        </select>
      </label>
      <fieldset class="td-field td-mode">
        <legend>Mode</legend>
        <label>
          <input
            type="radio"
            name="td-mode"
            checked={draft.mode === 'manual'}
            onChange={() => effects.editTaskDraft({ mode: 'manual' })}
          />
          <span>Manual</span>
        </label>
        <label>
          <input
            type="radio"
            name="td-mode"
            checked={draft.mode === 'coordinated'}
            onChange={() => effects.editTaskDraft({ mode: 'coordinated' })}
          />
          <span>Reviewed plan (coordinator)</span>
        </label>
      </fieldset>
    </div>
  );
}

/** Who synthesizes the result: always named on the card, chosen under Edit among valid owners only. */
function ResultOwner(props: Card): JSX.Element {
  const { effects } = useWorkspace();
  const { draft, context } = props;
  const owners = synthesisOwners(context, draft.workflow);
  const owner = owners.find((t) => t.id === draft.resultOwnerId);
  if (!draft.expanded || owners.length === 0)
    return (
      <p class="td-scope td-owner">
        <span class="muted">Result owner: </span>
        {owner === undefined ? (
          <span class="td-owner-none">none can synthesize this workflow</span>
        ) : (
          <>
            <Who id={owner.id} name={owner.name} size={20} />{' '}
            <span class="muted">{owner.role}</span>
          </>
        )}
      </p>
    );
  return (
    <label class="td-field">
      <span>Result owner</span>
      <select
        value={draft.resultOwnerId}
        onChange={(e) => effects.editTaskDraft({ resultOwnerId: e.currentTarget.value })}
      >
        {owners.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {t.role}
          </option>
        ))}
      </select>
    </label>
  );
}

function Specialists(props: Card): JSX.Element {
  const { draft, context } = props;
  if (draft.mode !== 'manual')
    return (
      <p class="muted td-coord">
        The coordinator proposes who does what and with which sources. You approve that plan before
        anything runs.
      </p>
    );
  return (
    <>
      <ul class="td-specs" aria-label="Specialists">
        {draft.specialists.map((s) => (
          <SpecialistRow key={s.teammateId} draft={draft} specialist={s} context={context} />
        ))}
      </ul>
      <AddSpecialist draft={draft} context={context} />
    </>
  );
}

function Actions(props: {
  readonly draft: TaskDraft;
  readonly problems: number;
  readonly starting: boolean;
}): JSX.Element {
  const { effects } = useWorkspace();
  return (
    <>
      <button
        type="button"
        class="btn btn-primary"
        disabled={props.problems > 0 || props.starting}
        aria-busy={props.starting}
        onClick={() => void effects.startTask()}
      >
        {props.starting ? 'Starting…' : 'Start'}
      </button>
      <button
        type="button"
        class="btn"
        aria-expanded={props.draft.expanded}
        onClick={() => effects.editTaskDraft({ expanded: !props.draft.expanded })}
      >
        {props.draft.expanded ? 'Hide details' : 'Edit'}
      </button>
      <button type="button" class="btn btn-quiet" onClick={() => effects.closeTaskDraft()}>
        Discard
      </button>
    </>
  );
}

export function TaskDraftCard(): JSX.Element | null {
  const { store, effects } = useWorkspace();
  const state = store.state.value;
  const draft = state.composer.taskDraft;
  const context = state.composer.context;
  if (draft === null || context === null || state.conversation?.id !== draft.conversationId)
    return null;
  const problems = draftProblems(draft);
  const files = draft.attachments;
  return (
    <CardFrame
      id="card-task-draft"
      kind="task_draft"
      label="Task draft"
      tone="muted"
      status={draft.mode === 'coordinated' ? 'Reviewed plan' : 'Manual'}
      title={draft.objective.trim() === '' ? 'New task' : draft.objective}
      actions={
        <Actions draft={draft} problems={problems.length} starting={state.composer.starting} />
      }
    >
      <div class="td" aria-busy={state.composer.starting}>
        <label class="td-field">
          <span>Objective</span>
          <textarea
            rows={2}
            value={draft.objective}
            onInput={(event) => effects.editTaskDraft({ objective: event.currentTarget.value })}
          />
        </label>
        <WorkflowAndMode draft={draft} context={context} />
        {draft.workflow === 'metrics_explanation' ? <MetricsFields draft={draft} /> : null}
        {draft.workflow === 'engineering_proposal' ? (
          <EngineeringFields draft={draft} context={context} />
        ) : null}
        {files.length > 0 ? (
          <p class="td-scope">
            <span class="muted">Files: </span>
            {files.map((f) => f.name).join(', ')}
          </p>
        ) : null}
        <Specialists draft={draft} context={context} />
        <ResultOwner draft={draft} context={context} />

        {problems.length > 0 ? (
          <p class="muted td-problems" id="td-problems">
            Before Start: {problems.join(' ')}
          </p>
        ) : null}
        <ErrorLine text={state.composer.error} />
      </div>
    </CardFrame>
  );
}
