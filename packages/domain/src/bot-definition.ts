import * as z from 'zod';

import { canonicalPayloadSha256, sha256DigestSchema } from './canonical-hash.js';
import { scheduleSpecSchema } from './schedule.js';
import { capabilitySchema } from './teamwork.js';

import type { Capability } from './teamwork.js';

const text = z.string().trim().min(1);
const stepId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const refs = z.array(stepId).max(4);
const base = { id: stepId, title: text.max(160), dependsOn: refs };
export const READ_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'drive.read',
  'bigquery.query',
  'github.read',
  'files.read',
  'notes.read',
]);
/**
 * Read capabilities a bot step cannot use yet. `bigquery.query` needs a metrics comparison scope
 * that the step contract does not carry, so it is refused at validation instead of failing at run
 * time (T7-05).
 */
export const BOT_UNSUPPORTED_CONNECTORS: ReadonlySet<Capability> = new Set(['bigquery.query']);
function validVersionIdentifiers(value: string, prerelease: boolean): boolean {
  return value
    .split('.')
    .every(
      (identifier) =>
        /^[0-9A-Za-z-]+$/.test(identifier) && !(prerelease && /^0[0-9]+$/.test(identifier)),
    );
}
function validSemver(value: string): boolean {
  const builds = value.split('+');
  if (builds.length > 2 || builds.slice(1).some((build) => !validVersionIdentifiers(build, false)))
    return false;
  const [core, ...pre] = builds[0].split('-');
  const parts = core.split('.');
  return (
    parts.length === 3 &&
    parts.every((part) => /^(0|[1-9][0-9]*)$/.test(part)) &&
    (pre.length === 0 || validVersionIdentifiers(pre.join('-'), true))
  );
}
export const botSkillRefSchema = z.strictObject({
  packageId: text.max(160),
  version: z.string().min(1).max(128).refine(validSemver, 'invalid semver'),
  digest: sha256DigestSchema,
  name: text.max(80),
});
export type SkillRef = z.infer<typeof botSkillRefSchema>;
export const botStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('connector_read'),
    capability: capabilitySchema.refine((v) => READ_CAPABILITIES.has(v), 'write_capability'),
    query: text.max(4000),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('skill'),
    skill: botSkillRefSchema,
    inputs: z.array(stepId).max(8),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('mcp_delegate'),
    agent: z.strictObject({ agentId: text.max(160), protocol: z.literal('mcp') }),
    instruction: text.max(4000),
    inputs: z.array(stepId).max(8),
    timeoutSeconds: z.number().int().min(10).max(86400),
  }),
  z.strictObject({ ...base, kind: z.literal('approval'), prompt: text.max(2000) }),
  z.strictObject({ ...base, kind: z.literal('result'), from: stepId }),
]);
export type BotStep = z.infer<typeof botStepSchema>;
export const botTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('schedule'),
    timezone: scheduleSpecSchema.shape.timezone.refine(
      (value) => !/^[+-]/.test(value),
      'invalid IANA timezone',
    ),
    timing: scheduleSpecSchema.shape.timing,
    allowedWindow: scheduleSpecSchema.shape.allowedWindow.optional(),
    missedRun: z.enum(['skip', 'run_once']),
  }),
  z.strictObject({ kind: z.literal('event'), source: text.max(160), eventType: text.max(160) }),
]);
export type BotTrigger = z.infer<typeof botTriggerSchema>;
export const botDefinitionSchema = z.strictObject({
  apiVersion: z.literal('agent-works.bot/v1'),
  name: text.max(80),
  purpose: text.max(2000),
  planning: z.strictObject({ mode: z.literal('fixed') }),
  workflow: z.strictObject({ steps: z.array(botStepSchema).min(2).max(8) }),
  triggers: z.array(botTriggerSchema).min(1).max(4),
  approvals: z.strictObject({ mode: z.enum(['per_run', 'standing_grant', 'checkpoints_only']) }),
  limits: z.strictObject({
    maxConcurrentRunsPerBot: z.number().int().min(1).max(5),
    maxConcurrentRunsPerUser: z.number().int().min(1).max(5),
    runTimeoutMinutes: z.number().int().min(1).max(1440),
    maxCostMicros: z.number().int().nonnegative().safe().nullable(),
  }),
  result: z.strictObject({ destination: z.literal('inbox') }),
});
export type BotDefinition = z.infer<typeof botDefinitionSchema>;
export type BotDiagnosticCode =
  | 'invalid_schema'
  | 'unsupported_planning_mode'
  | 'unsupported_protocol'
  | 'write_capability'
  | 'invalid_timezone'
  | 'duplicate_step_id'
  | 'cycle'
  | 'duplicate_reference'
  | 'dangling_reference'
  | 'reference_not_earlier'
  | 'input_not_dependency'
  | 'approval_not_data'
  | 'result_count'
  | 'result_not_sink'
  | 'unreachable_step'
  | 'checkpoint_input_not_upstream'
  | 'capability_not_allowed'
  | 'unsupported_connector'
  | 'unknown_agent'
  | 'unknown_package'
  | 'unknown_version'
  | 'digest_mismatch'
  | 'unknown_skill'
  | 'not_activated'
  | 'permission_escalation';
export type BotDiagnostic = {
  readonly code: BotDiagnosticCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
};
export type BotProposal =
  | {
      readonly success: true;
      readonly definition: BotDefinition;
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly BotDiagnostic[] };

export type ResolvedSkill = SkillRef & {
  description: string;
  instructions: string;
  allowedTools: readonly string[];
  provenance: { source: 'curated'; path: string; loadedAt: string };
};
export type SkillResolution =
  | { ok: true; skill: ResolvedSkill }
  | {
      ok: false;
      code:
        | 'unknown_package'
        | 'unknown_version'
        | 'digest_mismatch'
        | 'unknown_skill'
        | 'not_activated';
    };
export type SkillPackageResolver = { resolve(ref: SkillRef): Promise<SkillResolution> };
export type ApprovedBotAgent = {
  readonly agentId: string;
  readonly displayName: string;
  readonly protocol: 'mcp';
  readonly dataClassification: string;
  readonly supports: {
    readonly cancel: boolean;
    readonly lookupByIdempotencyKey: boolean;
    readonly reportsCost: boolean;
  };
};
export type BotValidationContext = {
  readonly segmentCapabilities: ReadonlySet<Capability>;
  readonly approvedAgents: { get(agentId: string): ApprovedBotAgent | undefined };
  readonly skills: SkillPackageResolver;
};

function schemaDiagnostics(error: z.ZodError): BotDiagnostic[] {
  return error.issues.map((issue) => {
    const path = issue.path.filter((part): part is string | number => typeof part !== 'symbol');
    let code: BotDiagnosticCode = 'invalid_schema';
    if (path.join('.') === 'planning.mode') code = 'unsupported_planning_mode';
    if (path.at(-1) === 'protocol') code = 'unsupported_protocol';
    if (issue.message === 'write_capability') code = 'write_capability';
    if (path.at(-1) === 'timezone') code = 'invalid_timezone';
    return { code, path, message: issue.message };
  });
}

type WorkflowGraph = {
  readonly byId: ReadonlyMap<string, BotStep>;
  readonly indices: ReadonlyMap<string, number>;
};
const stepDiagnostic = (
  code: BotDiagnosticCode,
  index: number,
  field: string,
  message: string,
): BotDiagnostic => ({ code, path: ['workflow', 'steps', index, field], message });
function ancestors(graph: WorkflowGraph, id: string, visiting = new Set<string>()): Set<string> {
  if (visiting.has(id)) return new Set();
  const seen = new Set(visiting).add(id);
  const out = new Set<string>();
  for (const dep of graph.byId.get(id)?.dependsOn ?? []) {
    out.add(dep);
    for (const ancestor of ancestors(graph, dep, seen)) out.add(ancestor);
  }
  return out;
}
function referenceDiagnostics(step: BotStep, index: number, graph: WorkflowGraph): BotDiagnostic[] {
  const diagnostics: BotDiagnostic[] = [];
  const references = [
    ...step.dependsOn,
    ...('inputs' in step ? step.inputs : []),
    ...(step.kind === 'result' ? [step.from] : []),
  ];
  for (const ref of new Set(references)) {
    const target = graph.indices.get(ref);
    if (target === undefined)
      diagnostics.push(
        stepDiagnostic('dangling_reference', index, 'dependsOn', `Unknown step ${ref}.`),
      );
    else if (target >= index)
      diagnostics.push(
        stepDiagnostic(
          'reference_not_earlier',
          index,
          'dependsOn',
          `Step ${ref} must be declared earlier.`,
        ),
      );
  }
  return diagnostics;
}
function inputDiagnostics(
  step: BotStep,
  index: number,
  graph: WorkflowGraph,
  dependencies: ReadonlySet<string>,
): BotDiagnostic[] {
  const field = step.kind === 'result' ? 'from' : 'inputs';
  const inputs = step.kind === 'result' ? [step.from] : 'inputs' in step ? step.inputs : [];
  return inputs.flatMap((ref) => [
    // Approvals gate work but produce no data: a dependency, never a data source (T9-01).
    ...(graph.byId.get(ref)?.kind === 'approval'
      ? [
          stepDiagnostic(
            'approval_not_data',
            index,
            field,
            `Step ${ref} is an approval and produces no data. Use the step whose output it approves.`,
          ),
        ]
      : []),
    ...(dependencies.has(ref)
      ? []
      : [
          stepDiagnostic(
            'input_not_dependency',
            index,
            field,
            `Input ${ref} must be a dependency or its ancestor.`,
          ),
        ]),
  ]);
}
function dependencyDiagnostics(
  step: BotStep,
  index: number,
  graph: WorkflowGraph,
): BotDiagnostic[] {
  const diagnostics = referenceDiagnostics(step, index, graph);
  const dependencies = ancestors(graph, step.id);
  if (dependencies.has(step.id))
    diagnostics.push(
      stepDiagnostic('cycle', index, 'dependsOn', 'Workflow dependencies contain a cycle.'),
    );
  if (new Set(step.dependsOn).size !== step.dependsOn.length)
    diagnostics.push(
      stepDiagnostic('duplicate_reference', index, 'dependsOn', 'Dependencies must be unique.'),
    );
  diagnostics.push(...inputDiagnostics(step, index, graph, dependencies));
  return diagnostics;
}
/** The step outputs a step consumes, as execution reads them. Approval steps carry no data. */
export function stepDataInputs(step: BotStep, byId: ReadonlyMap<string, BotStep>): string[] {
  const refs =
    'inputs' in step ? step.inputs : step.kind === 'result' ? [step.from] : step.dependsOn;
  return refs.filter((ref) => byId.get(ref)?.kind !== 'approval');
}
/**
 * A checkpoint approves the exact data its next steps will use, so that data must exist when the
 * owner is asked: every data input of a step that directly follows a checkpoint has to be upstream
 * of the checkpoint. Otherwise the approval could bind a value that changes later, or execution
 * would have to wait on siblings and could deadlock (T7-03, T8-01, T8-03).
 */
function notUpstream(
  checkpoint: BotStep,
  step: BotStep,
  index: number,
  graph: WorkflowGraph,
): BotDiagnostic[] {
  const upstream = ancestors(graph, checkpoint.id);
  return stepDataInputs(step, graph.byId)
    .filter((ref) => !upstream.has(ref))
    .map((ref) =>
      stepDiagnostic(
        'checkpoint_input_not_upstream',
        index,
        'dependsOn',
        `Step ${step.id} uses ${ref}, which checkpoint ${checkpoint.id} cannot approve because it is not upstream. Add ${ref} to the checkpoint's dependsOn.`,
      ),
    );
}
function checkpointDiagnostics(steps: readonly BotStep[], graph: WorkflowGraph): BotDiagnostic[] {
  return steps
    .filter((step) => step.kind === 'approval')
    .flatMap((checkpoint) =>
      steps.flatMap((step, index) =>
        step.dependsOn.includes(checkpoint.id) ? notUpstream(checkpoint, step, index, graph) : [],
      ),
    );
}
function resultDiagnostics(steps: readonly BotStep[], graph: WorkflowGraph): BotDiagnostic[] {
  const diagnostics: BotDiagnostic[] = [];
  const results = steps.filter((step) => step.kind === 'result');
  const path = ['workflow', 'steps'];
  if (results.length !== 1)
    diagnostics.push({
      code: 'result_count',
      path,
      message: 'Exactly one result step is required.',
    });
  const result = results.at(0);
  if (result === undefined) return diagnostics;
  if (steps.some((step) => step.dependsOn.includes(result.id)))
    diagnostics.push({ code: 'result_not_sink', path, message: 'The result step must be a sink.' });
  const dependencies = ancestors(graph, result.id);
  for (const [index, step] of steps.entries()) {
    if (step.id !== result.id && !dependencies.has(step.id))
      diagnostics.push(
        stepDiagnostic('unreachable_step', index, 'id', 'Every step must reach the result.'),
      );
  }
  return diagnostics;
}
function graphDiagnostics(definition: BotDefinition): BotDiagnostic[] {
  const steps = definition.workflow.steps;
  const diagnostics: BotDiagnostic[] = [];
  const indices = new Map<string, number>();
  for (const [index, step] of steps.entries()) {
    if (indices.has(step.id))
      diagnostics.push(
        stepDiagnostic('duplicate_step_id', index, 'id', 'Step ids must be unique.'),
      );
    indices.set(step.id, index);
  }
  const graph = { byId: new Map(steps.map((step) => [step.id, step])), indices };
  return [
    ...diagnostics,
    ...steps.flatMap((step, index) => dependencyDiagnostics(step, index, graph)),
    ...resultDiagnostics(steps, graph),
    ...checkpointDiagnostics(steps, graph),
  ];
}

/** Model proposals are untrusted. This boundary never throws, including for non-JSON objects. */
export function parseBotProposal(input: unknown): BotProposal {
  try {
    canonicalPayloadSha256(input);
    const parsed = botDefinitionSchema.safeParse(input);
    if (!parsed.success) return { success: false, diagnostics: schemaDiagnostics(parsed.error) };
    const diagnostics = graphDiagnostics(parsed.data);
    return diagnostics.length === 0
      ? { success: true, definition: parsed.data, diagnostics: [] }
      : { success: false, diagnostics };
  } catch {
    return {
      success: false,
      diagnostics: [
        {
          code: 'invalid_schema',
          path: [],
          message: 'Proposal must be a bounded JSON bot definition.',
        },
      ],
    };
  }
}

async function skillDiagnostics(
  step: Extract<BotStep, { kind: 'skill' }>,
  index: number,
  context: BotValidationContext,
  capabilities: ReadonlySet<string>,
): Promise<BotDiagnostic[]> {
  const resolved = await context.skills.resolve(step.skill);
  if (!resolved.ok)
    return [stepDiagnostic(resolved.code, index, 'skill', 'The pinned skill cannot be resolved.')];
  if (resolved.skill.digest !== step.skill.digest)
    return [
      stepDiagnostic('digest_mismatch', index, 'skill', 'The package digest does not match.'),
    ];
  if (resolved.skill.allowedTools.some((capability) => !capabilities.has(capability)))
    return [
      stepDiagnostic(
        'permission_escalation',
        index,
        'skill',
        'Skill tools must be a subset of the bot capability set.',
      ),
    ];
  return [];
}

function connectorDiagnostics(
  step: Extract<BotStep, { kind: 'connector_read' }>,
  index: number,
  context: BotValidationContext,
): BotDiagnostic[] {
  const found: BotDiagnostic[] = [];
  if (BOT_UNSUPPORTED_CONNECTORS.has(step.capability))
    found.push(
      stepDiagnostic(
        'unsupported_connector',
        index,
        'capability',
        'This connector cannot be used in a bot step yet.',
      ),
    );
  if (!context.segmentCapabilities.has(step.capability))
    found.push(
      stepDiagnostic(
        'capability_not_allowed',
        index,
        'capability',
        'Capability is not enabled in this segment.',
      ),
    );
  return found;
}

/** No state changes. Catalog ports describe the server's current approved snapshot. */
export async function validateBotDefinition(
  input: unknown,
  context: BotValidationContext,
): Promise<readonly BotDiagnostic[]> {
  const parsed = parseBotProposal(input);
  if (!parsed.success) return parsed.diagnostics;
  const diagnostics: BotDiagnostic[] = [];
  const capabilities = new Set(
    parsed.definition.workflow.steps
      .filter((step) => step.kind === 'connector_read')
      .map((step) => step.capability),
  );
  for (const [index, step] of parsed.definition.workflow.steps.entries()) {
    if (step.kind === 'connector_read')
      diagnostics.push(...connectorDiagnostics(step, index, context));
    if (
      step.kind === 'mcp_delegate' &&
      context.approvedAgents.get(step.agent.agentId) === undefined
    )
      diagnostics.push(
        stepDiagnostic('unknown_agent', index, 'agent', 'Agent is not in the approved registry.'),
      );
    if (step.kind === 'skill')
      diagnostics.push(...(await skillDiagnostics(step, index, context, capabilities)));
  }
  return diagnostics;
}
