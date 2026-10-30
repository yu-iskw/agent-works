import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';

/** Version tag on every teamwork API body; a client rejects a server that answers another one. */
export const TEAMWORK_API_VERSION = 'teamwork.v1';

const text = z.string().trim().min(1);
const at = z.iso.datetime({ offset: true });
const id = z.uuid();

export const IDENTITY_MODES = ['google', 'local-test'] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

/**
 * Issuer of the member assertions web mints for segment APIs. Each identity mode has its own, so a
 * segment API configured for real Google sign-in cannot accept a local-test identity at all.
 */
export const ASSERTION_ISSUERS: Record<IdentityMode, string> = {
  google: 'https://aw-m1-web.local/google',
  'local-test': 'https://aw-m1-web.local/local-test',
};

export const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const segmentIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/)
  .brand<'SegmentId'>();
export type SegmentId = z.infer<typeof segmentIdSchema>;

/**
 * Every capability a teammate can request, keyed to the external provider that backs it
 * (a capability needs that connection). Granting is a backend policy decision
 * (`teamwork-policy.ts`); model output can name these but never enable one. A `null` provider
 * marks a capability the segment grants to every teammate without a connection: reading the
 * files the member attached is one.
 */
export const CAPABILITY_PROVIDER = {
  'drive.read': 'google',
  'docs.publish': 'google',
  'bigquery.query': 'google',
  'github.read': 'github',
  'files.read': null,
} as const satisfies Record<string, 'google' | 'github' | null>;
export type Capability = keyof typeof CAPABILITY_PROVIDER;
export const CAPABILITIES = Object.keys(CAPABILITY_PROVIDER) as readonly Capability[];
export const capabilitySchema = z.enum(CAPABILITIES);

export const WORKFLOWS = ['research_brief', 'metrics_explanation', 'engineering_proposal'] as const;
export const workflowSchema = z.enum(WORKFLOWS);
export type Workflow = z.infer<typeof workflowSchema>;

/** Statement kinds the UI keeps visually distinct. `support` is set by validation, never by the model. */
export const STATEMENT_KINDS = [
  'fact',
  'calculation',
  'assumption',
  'hypothesis',
  'question',
  'recommendation',
  'proposed_action',
] as const;
export const statementKindSchema = z.enum(STATEMENT_KINDS);
export type StatementKind = z.infer<typeof statementKindSchema>;

/** Kinds that assert something about sources and therefore must be backed by evidence. */
export const MATERIAL_KINDS: ReadonlySet<StatementKind> = new Set(['fact', 'calculation']);

export const statementSchema = z.strictObject({
  kind: statementKindSchema,
  text: text.max(1200),
  evidenceIds: z.array(z.string().regex(/^E\d{1,3}$/)).max(12),
  calculationIds: z.array(z.string().regex(/^C\d{1,3}$/)).max(12),
  support: z.enum(['supported', 'unsupported', 'not_required']),
});
export type Statement = z.infer<typeof statementSchema>;

export const sectionSchema = z.strictObject({
  heading: text.max(120),
  statements: z.array(statementSchema).max(40),
});
export type Section = z.infer<typeof sectionSchema>;

// ---------------------------------------------------------------------------------------------
// Catalog: templates and skills are independent, immutable once versioned.

export const skillInputSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: text.max(300),
  required: z.boolean(),
});

export const skillDefinitionSchema = z.strictObject({
  name: text.max(80),
  summary: text.max(300),
  workflows: z.array(workflowSchema).min(1),
  applicability: text.max(600),
  inputs: z.array(skillInputSchema).max(10),
  steps: z.array(text.max(400)).min(1).max(12),
  validation: z.array(text.max(300)).max(10),
  /** Section headings every output produced under this skill must contain, in order. */
  outputSections: z.array(text.max(120)).min(1).max(10),
  missingData: text.max(400),
  approvalBoundary: text.max(400),
  capabilities: z.array(capabilitySchema).max(CAPABILITIES.length),
});
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;

export const templateDefinitionSchema = z.strictObject({
  name: text.max(80),
  role: text.max(160),
  instructions: text.max(4000),
  /** Skill names this template is designed for; attaching others is allowed if compatible. */
  compatibleSkills: z.array(text.max(80)).max(10),
  capabilityRequests: z.array(capabilitySchema).max(CAPABILITIES.length),
});
export type TemplateDefinition = z.infer<typeof templateDefinitionSchema>;

const versionRef = z.strictObject({ id, version: z.number().int().positive() });
export type VersionRef = z.infer<typeof versionRef>;

export const catalogOrigin = z.enum(['curated', 'private', 'imported']);

export const skillViewSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  origin: catalogOrigin,
  derivedFrom: versionRef.nullable(),
  ownerSub: z.string().nullable(),
  definition: skillDefinitionSchema,
  createdAt: at,
  /** Teammates of the caller that have this skill attached (any version). */
  attachedTo: z.array(id),
});
export type SkillView = z.infer<typeof skillViewSchema>;

export const templateViewSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  origin: catalogOrigin,
  definition: templateDefinitionSchema,
  createdAt: at,
});
export type TemplateView = z.infer<typeof templateViewSchema>;

export const capabilityStateSchema = z.strictObject({
  capability: capabilitySchema,
  requested: z.boolean(),
  /** Granted by segment policy and member entitlement, before connection state. */
  permitted: z.boolean(),
  connected: z.boolean(),
  effective: z.boolean(),
  reason: z.string().nullable(),
});
export type CapabilityState = z.infer<typeof capabilityStateSchema>;

/**
 * Display identity a member picks for a personal teammate. Closed sets, so a value can never be
 * a URL or free text; stored on the teammate row only and never snapshotted, templated or exported.
 */
export const AVATAR_IDS = [
  'leaf',
  'sun',
  'moon',
  'wave',
  'spark',
  'stone',
  'bloom',
  'orbit',
] as const;
export const avatarIdSchema = z.enum(AVATAR_IDS);
export type AvatarId = z.infer<typeof avatarIdSchema>;
export const ACCENTS = ['mint', 'amber', 'lavender', 'blue', 'coral', 'slate'] as const;
export const accentSchema = z.enum(ACCENTS);
export type Accent = z.infer<typeof accentSchema>;

export const appearanceSchema = z.strictObject({
  avatar: avatarIdSchema.nullable(),
  accent: accentSchema.nullable(),
});
export type Appearance = z.infer<typeof appearanceSchema>;

export const teammateViewSchema = z.strictObject({
  id,
  name: text.max(80),
  role: text.max(160),
  instructions: text.max(4000),
  template: versionRef.extend({ name: text }),
  skills: z.array(versionRef.extend({ name: text })),
  capabilities: z.array(capabilityStateSchema),
  version: z.number().int().positive(),
  origin: z.enum(['template', 'imported']),
  conversationId: id,
  appearance: appearanceSchema,
  createdAt: at,
  updatedAt: at,
});
export type TeammateView = z.infer<typeof teammateViewSchema>;

export const teammateCreateSchema = z.strictObject({
  templateId: id,
  name: text.max(80).optional(),
  clientRequestId: id,
});

export const teammateUpdateSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  name: text.max(80),
  role: text.max(160),
  instructions: text.max(4000),
  /** Omitted keeps the stored value; null clears it. */
  avatar: avatarIdSchema.nullable().optional(),
  accent: accentSchema.nullable().optional(),
});

export const skillAttachSchema = z.strictObject({
  skillId: id,
  version: z.number().int().positive(),
  attach: z.boolean(),
});

export const skillCustomizeSchema = z.strictObject({
  fromSkillId: id,
  fromVersion: z.number().int().positive(),
  definition: skillDefinitionSchema,
});

// ---------------------------------------------------------------------------------------------
// Portable definitions: an explicit allowlist. Nothing outside these fields can be exported.

export const PORTABLE_FORMAT = 'aw.teamwork.definition.v1';

export const portableParameterSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/),
  description: text.max(300),
});

export const portableDefinitionSchema = z.strictObject({
  format: z.literal(PORTABLE_FORMAT),
  kind: z.literal('teammate'),
  name: text.max(80),
  role: text.max(160),
  instructions: text.max(4000),
  capabilityRequests: z.array(capabilitySchema).max(CAPABILITIES.length),
  skills: z.array(skillDefinitionSchema).max(10),
  /** Inputs a recipient supplies with their own sources; never resolved values. */
  parameters: z.array(portableParameterSchema).max(10),
});
export type PortableDefinition = z.infer<typeof portableDefinitionSchema>;

// ---------------------------------------------------------------------------------------------
// Tasks, plans and assignments.

export const TEAMWORK_STATUSES = [
  'planning',
  'plan_review',
  'running',
  'needs_input',
  'synthesizing',
  'ready',
  'awaiting_action_approval',
  'publishing',
  'completed',
  'outcome_uncertain',
  'failed',
  'declined',
  'cancel_requested',
  'cancelled',
] as const;
export const teamworkStatusSchema = z.enum(TEAMWORK_STATUSES);
export type TeamworkStatus = z.infer<typeof teamworkStatusSchema>;

/**
 * The teamwork task lifecycle. A revision re-enters `synthesizing` from `ready` or `completed`;
 * a scope change goes back through `plan_review` so new work is never dispatched unreviewed.
 */
export const TEAMWORK_TRANSITIONS: Record<TeamworkStatus, readonly TeamworkStatus[]> = {
  planning: ['plan_review', 'failed', 'cancel_requested', 'cancelled'],
  plan_review: ['running', 'planning', 'declined', 'cancelled'],
  running: ['synthesizing', 'needs_input', 'failed', 'cancel_requested'],
  needs_input: ['running', 'synthesizing', 'planning', 'plan_review', 'cancelled'],
  synthesizing: ['ready', 'needs_input', 'failed', 'cancel_requested'],
  ready: [
    'synthesizing',
    'running',
    'plan_review',
    'awaiting_action_approval',
    'completed',
    'cancelled',
  ],
  awaiting_action_approval: ['publishing', 'ready', 'completed', 'cancelled'],
  publishing: ['completed', 'failed', 'outcome_uncertain'],
  outcome_uncertain: ['publishing', 'completed'],
  failed: ['planning', 'running', 'synthesizing', 'publishing', 'ready', 'cancelled'],
  completed: ['synthesizing', 'running', 'awaiting_action_approval'],
  declined: [],
  cancel_requested: ['cancelled'],
  cancelled: [],
};

export function canTeamworkTransition(from: TeamworkStatus, to: TeamworkStatus): boolean {
  // eslint-disable-next-line security/detect-object-injection
  return TEAMWORK_TRANSITIONS[from].includes(to);
}

export const ASSIGNMENT_STATUSES = [
  'queued',
  'running',
  'needs_input',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'superseded',
] as const;
export const assignmentStatusSchema = z.enum(ASSIGNMENT_STATUSES);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

export const ASSIGNMENT_TRANSITIONS: Record<AssignmentStatus, readonly AssignmentStatus[]> = {
  queued: ['running', 'cancelled', 'superseded'],
  running: ['succeeded', 'failed', 'timed_out', 'needs_input', 'cancelled', 'queued', 'superseded'],
  needs_input: ['queued', 'cancelled', 'superseded'],
  succeeded: ['queued', 'superseded'],
  failed: ['queued', 'cancelled', 'superseded'],
  timed_out: ['queued', 'cancelled', 'superseded'],
  cancelled: [],
  superseded: [],
};

export function canAssignmentTransition(from: AssignmentStatus, to: AssignmentStatus): boolean {
  // eslint-disable-next-line security/detect-object-injection
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
}

export const TERMINAL_ASSIGNMENT: ReadonlySet<AssignmentStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
  'superseded',
]);

/** Named source inputs; the segment maps each to an allowlisted resource the member can read. */
export const SOURCE_KINDS = [
  'drive_research',
  'drive_context',
  'bigquery_metrics',
  'github_issue',
  'github_code',
  'member_file',
] as const;
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

export const SOURCE_CAPABILITY: Record<SourceKind, Capability> = {
  drive_research: 'drive.read',
  drive_context: 'drive.read',
  bigquery_metrics: 'bigquery.query',
  github_issue: 'github.read',
  github_code: 'github.read',
  member_file: 'files.read',
};

/** The result of reading one source once on the member's behalf, before any task uses it. */
export type SourceCheck = {
  readonly source: SourceKind;
  readonly status: 'reachable' | 'no_data' | 'not_allowed' | 'unreachable';
  readonly detail: string;
};

// ---------------------------------------------------------------------------------------------
// Member files: bounded text a member attaches in a conversation, read by tasks as evidence.

/** UTF-8 bytes of text one file may hold. */
export const ATTACHMENT_MAX_BYTES = 200 * 1024;
/** Files one message or task scope may carry. */
export const ATTACHMENT_MAX_PER_MESSAGE = 5;
export const ATTACHMENT_NAME_MAX = 120;
/** Characters of the file shown as its preview. */
export const ATTACHMENT_PREVIEW_CHARS = 600;
export const ATTACHMENT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;
export const attachmentMediaTypeSchema = z.enum(ATTACHMENT_MEDIA_TYPES);
export type AttachmentMediaType = z.infer<typeof attachmentMediaTypeSchema>;

/**
 * The upload body. `mediaType` is a plain string so an unsupported type is refused with a
 * message that names it, not a schema error; the content rules live with the API's validator.
 */
export const attachmentUploadSchema = z.strictObject({
  name: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX),
  mediaType: z.string().trim().min(1).max(100),
  /** Bounded in characters here; the byte limit is checked where it can be explained. */
  text: z.string().max(ATTACHMENT_MAX_BYTES * 4),
});
export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

/** What a message or task carries about a file: enough for a chip, never the content. */
export const attachmentRefSchema = z.strictObject({
  id,
  name: text.max(ATTACHMENT_NAME_MAX),
  mediaType: attachmentMediaTypeSchema,
  sizeBytes: z.number().int().positive(),
});
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const attachmentViewSchema = attachmentRefSchema.extend({
  sha256: sha256DigestSchema,
  createdAt: at,
  preview: z.string().max(ATTACHMENT_PREVIEW_CHARS),
  lines: z.number().int().positive(),
  /** Set once the member removed it; a referenced file keeps serving as provenance. */
  removedAt: at.nullable(),
});
export type AttachmentView = z.infer<typeof attachmentViewSchema>;

const attachmentIds = z.array(id).max(ATTACHMENT_MAX_PER_MESSAGE);

export const metricsScopeSchema = z.strictObject({
  baseline: z.string().regex(/^\d{4}-\d{2}$/),
  current: z.string().regex(/^\d{4}-\d{2}$/),
  groupBy: z.enum(['region', 'channel']),
});
export type MetricsScope = z.infer<typeof metricsScopeSchema>;

export const plannedAssignmentSchema = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  teammateId: id,
  brief: text.max(1200),
  deliverable: text.max(400),
  sources: z.array(sourceKindSchema).min(1).max(SOURCE_KINDS.length),
  dependsOn: z.array(z.string()).max(5),
});
export type PlannedAssignment = z.infer<typeof plannedAssignmentSchema>;

/** Inputs shared by every assignment of a task: what to work on, never which credentials. */
export const taskScopeSchema = z.strictObject({
  question: text.max(1200),
  metrics: metricsScopeSchema.nullable(),
  /** owner/name; must be on the segment allowlist. */
  repository: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .nullable(),
  issueNumber: z.number().int().positive().nullable(),
  /** Member files from the task's conversation, read by every assignment as `member_file` evidence. */
  attachmentIds: attachmentIds.optional(),
});
export type TaskScope = z.infer<typeof taskScopeSchema>;

export const planContentSchema = z.strictObject({
  summary: text.max(1200),
  assignments: z.array(plannedAssignmentSchema).min(1).max(4),
  synthesisOwner: id,
  expectedEffects: z.array(text.max(300)).max(5),
});
export type PlanContent = z.infer<typeof planContentSchema>;

export const planViewSchema = z.strictObject({
  version: z.number().int().positive(),
  state: z.enum(['proposed', 'approved', 'rejected', 'superseded']),
  author: z.enum(['coordinator', 'member']),
  content: planContentSchema,
  /** Capabilities and external effects the plan would use, computed by policy. */
  capabilities: z.array(capabilitySchema),
  digest: sha256DigestSchema,
  createdAt: at,
  decidedAt: at.nullable(),
});
export type PlanView = z.infer<typeof planViewSchema>;

export const evidenceViewSchema = z.strictObject({
  id: z.string().regex(/^E\d{1,3}$/),
  assignmentId: id.nullable(),
  sourceKind: sourceKindSchema,
  sourceId: text,
  title: text,
  location: text,
  excerpt: text,
  url: z.string().nullable(),
  sourceRevision: z.string().nullable(),
  modifiedAt: at.nullable(),
  retrievedAt: at,
  stale: z.boolean(),
  provenance: text,
});
export type EvidenceView = z.infer<typeof evidenceViewSchema>;

export const calculationSchema = z.strictObject({
  id: z.string().regex(/^C\d{1,3}$/),
  metric: text,
  unit: text,
  group: text,
  groupBy: z.enum(['region', 'channel']),
  baseline: text,
  current: text,
  baselineValue: z.number(),
  currentValue: z.number(),
  change: z.number(),
  changePct: z.number().nullable(),
  query: text,
  evidenceId: z.string().regex(/^E\d{1,3}$/),
});
export type Calculation = z.infer<typeof calculationSchema>;

export const contributionSchema = z.strictObject({
  summary: text.max(1500),
  statements: z.array(statementSchema).max(30),
  gaps: z.array(text.max(400)).max(10),
  /** Set when the specialist cannot proceed without information only the member has. */
  question: text.max(600).nullable(),
});
export type Contribution = z.infer<typeof contributionSchema>;

export const assignmentViewSchema = z.strictObject({
  id,
  key: z.string(),
  teammateId: id,
  teammateName: text,
  skills: z.array(versionRef.extend({ name: text })),
  brief: text,
  deliverable: text,
  sources: z.array(sourceKindSchema),
  status: assignmentStatusSchema,
  attempt: z.number().int().positive(),
  planVersion: z.number().int().positive().nullable(),
  question: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: at.nullable(),
  finishedAt: at.nullable(),
  deadlineAt: at,
  output: contributionSchema.nullable(),
  model: z
    .strictObject({ modelVersion: text, responseId: z.string().nullable(), latencyMs: z.number() })
    .nullable(),
});
export type AssignmentView = z.infer<typeof assignmentViewSchema>;

export const artifactContentSchema = z.strictObject({
  title: text.max(200),
  summary: text.max(2000),
  sections: z.array(sectionSchema).min(1).max(12),
  limitations: z.array(text.max(400)).max(10),
});
export type ArtifactContent = z.infer<typeof artifactContentSchema>;

export const revisionDiffSchema = z.strictObject({
  added: z.array(z.strictObject({ heading: text, text })),
  removed: z.array(z.strictObject({ heading: text, text })),
  changedSections: z.array(text),
  sourcesAdded: z.array(text),
  sourcesRemoved: z.array(text),
});
export type RevisionDiff = z.infer<typeof revisionDiffSchema>;

export const revisionViewSchema = z.strictObject({
  revision: z.number().int().positive(),
  parent: z.number().int().positive().nullable(),
  request: z.string().nullable(),
  content: artifactContentSchema,
  evidenceIds: z.array(z.string()),
  calculations: z.array(calculationSchema),
  unsupported: z.number().int().nonnegative(),
  droppedCitations: z.number().int().nonnegative(),
  missingAssignments: z.array(z.string()),
  generation: z.strictObject({
    modelId: text,
    modelVersion: text,
    responseId: z.string().nullable(),
    planVersion: z.number().int().positive().nullable(),
    skills: z.array(versionRef.extend({ name: text })),
    repositoryRevision: z.string().nullable(),
  }),
  diff: revisionDiffSchema.nullable(),
  digest: sha256DigestSchema,
  createdAt: at,
});
export type RevisionView = z.infer<typeof revisionViewSchema>;

export const publishProposalSchema = z.strictObject({
  tool: z.literal('google_docs.create'),
  account: text,
  destination: text,
  documentTitle: text,
  revision: z.number().int().positive(),
  contentMarkdown: text,
  wordCount: z.number().int().nonnegative(),
  consequences: z.array(text),
});
export type PublishProposal = z.infer<typeof publishProposalSchema>;

export const actionApprovalViewSchema = z.strictObject({
  id,
  state: z.enum(['pending', 'approved', 'rejected', 'void']),
  proposal: publishProposalSchema,
  digest: sha256DigestSchema,
  requestedAt: at,
  expiresAt: at,
  decidedAt: at.nullable(),
  action: z
    .strictObject({
      status: z.enum(['intended', 'succeeded', 'failed', 'uncertain']),
      attempts: z.number().int().nonnegative(),
      externalId: z.string().nullable(),
      externalUrl: z.string().nullable(),
      confirmedAt: at.nullable(),
    })
    .nullable(),
});
export type ActionApprovalView = z.infer<typeof actionApprovalViewSchema>;

export const MESSAGE_CARD_KINDS = [
  'task_created',
  'plan_review',
  'result_ready',
  'question',
  'approval',
  'failed',
  'uncertain',
] as const;
export type MessageCardKind = (typeof MESSAGE_CARD_KINDS)[number];

/**
 * A persisted pointer from a conversation to a task. It fixes where a card sits in the timeline;
 * what the card says is derived from the task's current state. `ref` is the inbox ref the card
 * anchors (`plan:2`, `approval:<id>`), or `revision:<n>` for a result; rows written before the
 * UI milestone have none.
 */
export const messageCardSchema = z.strictObject({
  kind: z.enum(MESSAGE_CARD_KINDS),
  taskId: id,
  title: text,
  ref: z.string().optional(),
});
export type MessageCard = z.infer<typeof messageCardSchema>;

export const messageViewSchema = z.strictObject({
  id,
  role: z.enum(['member', 'teammate', 'system']),
  text: text.max(8000),
  taskId: id.nullable(),
  card: messageCardSchema.nullable(),
  /** A member question still waiting for the teammate's reply. */
  pending: z.boolean(),
  at,
  /** Files sent with a member message. The API always sets it; clients built before it may omit it. */
  attachments: z.array(attachmentRefSchema).optional(),
});
export type MessageView = z.infer<typeof messageViewSchema>;

export const INBOX_KINDS = [
  'question',
  'plan_review',
  'approval',
  'completed',
  'failed',
  'uncertain',
] as const;
export const inboxKindSchema = z.enum(INBOX_KINDS);
export type InboxKind = z.infer<typeof inboxKindSchema>;

export const inboxItemSchema = z.strictObject({
  id,
  kind: inboxKindSchema,
  taskId: id,
  taskTitle: text,
  ref: text,
  summary: text,
  state: z.enum(['open', 'resolved', 'dismissed']),
  createdAt: at,
  resolvedAt: at.nullable(),
});
export type InboxItem = z.infer<typeof inboxItemSchema>;

export const taskSummarySchema = z.strictObject({
  id,
  title: text,
  workflow: workflowSchema,
  mode: z.enum(['manual', 'coordinated']),
  status: teamworkStatusSchema,
  version: z.number().int().positive(),
  resultOwner: id,
  conversationId: id.nullable(),
  latestRevision: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: at,
  updatedAt: at,
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;

export const taskEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  type: text,
  summary: text,
  at,
  durationMs: z.number().int().nonnegative().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const taskDetailSchema = z.strictObject({
  apiVersion: z.literal(TEAMWORK_API_VERSION),
  segment: z.string(),
  task: taskSummarySchema,
  scope: taskScopeSchema,
  plans: z.array(planViewSchema),
  assignments: z.array(assignmentViewSchema),
  evidence: z.array(evidenceViewSchema),
  revisions: z.array(revisionViewSchema),
  approvals: z.array(actionApprovalViewSchema),
  messages: z.array(messageViewSchema),
  events: z.array(taskEventSchema),
});
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const manualAssignmentSchema = z.strictObject({
  teammateId: id,
  brief: text.max(1200),
  sources: z.array(sourceKindSchema).min(1).max(SOURCE_KINDS.length),
});

export const taskCreateSchema = z.strictObject({
  clientRequestId: id,
  workflow: workflowSchema,
  mode: z.enum(['manual', 'coordinated']),
  scope: taskScopeSchema,
  resultOwner: id,
  conversationId: id.nullable(),
  /** Manual mode only; coordinated mode gets assignments from an approved plan. */
  assignments: z.array(manualAssignmentSchema).max(4),
});
export type TaskCreate = z.infer<typeof taskCreateSchema>;

export const planDecisionSchema = z.strictObject({
  version: z.number().int().positive(),
  expectedDigest: sha256DigestSchema,
  decision: z.enum(['approve', 'reject']),
});

export const planEditSchema = z.strictObject({
  baseVersion: z.number().int().positive(),
  content: planContentSchema,
});

export const followUpSchema = z.strictObject({
  clientRequestId: id,
  kind: z.enum(['revise', 'answer', 'question', 'rescope']),
  text: text.max(2000),
  /** For `answer`: the assignment whose question this answers. */
  assignmentId: id.nullable(),
  /** For `rescope` on a metrics task: the new comparison. */
  metrics: metricsScopeSchema.nullable(),
});

export const planReplanSchema = z.strictObject({ feedback: text.max(2000) });
export const publishRequestSchema = z.strictObject({ revision: z.number().int().positive() });
export const connectionCompleteSchema = z.strictObject({
  code: text.max(2000),
  state: text.max(200),
});
export const importSchema = z.strictObject({
  clientRequestId: id,
  definition: z.string().min(2).max(100_000),
});

export const missingDecisionSchema = z.strictObject({
  decision: z.enum(['retry', 'proceed']),
  assignmentIds: z.array(id).max(4),
});

export const actionDecisionSchema = z.strictObject({
  approvalId: id,
  expectedDigest: sha256DigestSchema,
  decision: z.enum(['approve', 'reject']),
});

export const conversationPostSchema = z.strictObject({
  clientRequestId: id,
  text: text.max(4000),
  /** Files uploaded to this conversation by the member; the reply may read them. */
  attachmentIds: attachmentIds.optional(),
});

// ---------------------------------------------------------------------------------------------
// Bounded listing. Every list the workspace renders is paged by an opaque cursor so a member with
// hundreds of tasks never gets them all in one response.

/** Position of the last row a page held: the ordering timestamp (ISO, ms) and the row id. */
export type Cursor = { readonly at: string; readonly id: string };

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
export const cursorSchema = z.string().regex(CURSOR_PATTERN);

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Undefined for anything that is not a cursor this server produced. */
export function decodeCursor(raw: string): Cursor | undefined {
  if (!CURSOR_PATTERN.test(raw)) return undefined;
  const [atPart, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const idPart = rest.join('|');
  if (idPart.length === 0 || Number.isNaN(Date.parse(atPart))) return undefined;
  return { at: atPart, id: idPart };
}

/** A query string value: an empty string means the parameter was not given. */
const blankAsAbsent = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

export const LIST_LIMIT_MAX = 50;
const limit = z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(25);
const search = z.string().trim().max(200).default('');

export const TASK_LIST_STATUSES = ['all', 'running', 'attention', 'completed'] as const;
export type TaskListStatus = (typeof TASK_LIST_STATUSES)[number];

/**
 * Which task statuses each Work filter shows. `attention` is not a status set: it is any task
 * with an open inbox item, so the Work tab and the inbox agree on what needs the member.
 */
export const TASK_LIST_STATUS_FILTER: Record<
  Exclude<TaskListStatus, 'all' | 'attention'>,
  readonly TeamworkStatus[]
> = {
  running: ['planning', 'running', 'synthesizing', 'publishing', 'cancel_requested'],
  completed: ['completed'],
};

export const taskListQuerySchema = z.object({
  status: blankAsAbsent(z.enum(TASK_LIST_STATUSES).default('all')),
  q: blankAsAbsent(search),
  cursor: blankAsAbsent(cursorSchema.optional()),
  limit: blankAsAbsent(limit),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

export const inboxListQuerySchema = z.object({
  state: blankAsAbsent(z.enum(['open', 'resolved']).default('open')),
  cursor: blankAsAbsent(cursorSchema.optional()),
  limit: blankAsAbsent(limit),
});
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const resultListQuerySchema = z.object({
  q: blankAsAbsent(search),
  cursor: blankAsAbsent(cursorSchema.optional()),
  limit: blankAsAbsent(limit),
});
export type ResultListQuery = z.infer<typeof resultListQuerySchema>;

/** One artifact revision in the Results tab; the producing teammate is the task's result owner. */
export const resultEntrySchema = z.strictObject({
  taskId: id,
  taskTitle: text,
  revision: z.number().int().positive(),
  latestRevision: z.number().int().positive(),
  title: text,
  producedBy: z.strictObject({ id, name: text }),
  conversationId: id.nullable(),
  createdAt: at,
});
export type ResultEntry = z.infer<typeof resultEntrySchema>;

export const teammateRowSchema = teammateViewSchema.extend({
  lastMessage: z
    .strictObject({ text: z.string(), at, role: z.enum(['member', 'teammate', 'system']) })
    .nullable(),
  /** A teammate or system message after the member's read marker. */
  unread: z.boolean(),
  /** A linked task is planning, running, synthesizing or publishing, or a reply is pending. */
  working: z.boolean(),
  /** An open decision (question, plan review, approval, failure, uncertain effect) on a linked task. */
  needsAttention: z.boolean(),
  /** A result card after the read marker. */
  unreadResult: z.boolean(),
});
export type TeammateRow = z.infer<typeof teammateRowSchema>;

export const conversationQuerySchema = z
  .object({
    after: blankAsAbsent(cursorSchema.optional()),
    before: blankAsAbsent(cursorSchema.optional()),
    limit: blankAsAbsent(z.coerce.number().int().min(1).max(100).default(50)),
  })
  .refine((query) => query.after === undefined || query.before === undefined, {
    message: 'after and before are exclusive',
  });
export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

export const REPLY_STATES = ['none', 'queued', 'generating'] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

export const linkedTaskSchema = z.strictObject({
  id,
  version: z.number().int().positive(),
  status: teamworkStatusSchema,
  title: text,
});
export type LinkedTask = z.infer<typeof linkedTaskSchema>;

/**
 * One page of a conversation. `nextCursor` is the newest message held (pass as `after` to poll);
 * `prevCursor` is set when older messages exist before the page (pass as `before`).
 */
export const conversationPageSchema = z.strictObject({
  id,
  teammateId: id,
  messages: z.array(messageViewSchema),
  nextCursor: cursorSchema.nullable(),
  prevCursor: cursorSchema.nullable(),
  reply: z.enum(REPLY_STATES),
  tasks: z.array(linkedTaskSchema),
});
export type ConversationPage = z.infer<typeof conversationPageSchema>;

export const conversationReadSchema = z.strictObject({ upToMessageId: id });

export const readMarkerSchema = z.strictObject({
  lastReadMessageId: id,
  /** `created_at` of that message, so "after the marker" is a position, not a wall-clock time. */
  lastReadAt: at,
});
export type ReadMarker = z.infer<typeof readMarkerSchema>;
