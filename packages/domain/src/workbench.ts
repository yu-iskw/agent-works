import * as z from 'zod';

import { sha256DigestSchema } from './canonical-hash.js';

/** Version tag carried by every workbench API body so clients can reject a mismatched server. */
export const WORKBENCH_API_VERSION = 'workbench.v1';

export const WORKBENCH_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'executing',
  'completed',
  'declined',
  'failed',
  'cancel_requested',
  'cancelled',
  'outcome_uncertain',
] as const;

export const workbenchStatusSchema = z.enum(WORKBENCH_STATUSES);
export type WorkbenchStatus = z.infer<typeof workbenchStatusSchema>;

export const WORKBENCH_TRANSITIONS: Record<WorkbenchStatus, readonly WorkbenchStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['waiting_approval', 'completed', 'failed', 'cancel_requested'],
  cancel_requested: ['cancelled', 'failed'],
  waiting_approval: ['executing', 'declined', 'cancelled', 'failed'],
  executing: ['completed', 'failed', 'outcome_uncertain'],
  outcome_uncertain: ['executing', 'completed'],
  failed: ['queued', 'executing'],
  completed: [],
  declined: [],
  cancelled: [],
};

export function canTransition(from: WorkbenchStatus, to: WorkbenchStatus): boolean {
  // eslint-disable-next-line security/detect-object-injection
  return WORKBENCH_TRANSITIONS[from].includes(to);
}

export const WORKBENCH_EVENT_TYPES = [
  'task.created',
  'task.started',
  'retrieval.started',
  'retrieval.completed',
  'retrieval.denied',
  'evidence.recorded',
  'model.requested',
  'model.completed',
  'model.failed',
  'citations.validated',
  'draft.created',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'action.started',
  'action.completed',
  'action.failed',
  'action.uncertain',
  'action.reconciled',
  'task.completed',
  'task.failed',
  'task.cancel_requested',
  'task.cancelled',
  'task.retried',
] as const;

export const workbenchEventTypeSchema = z.enum(WORKBENCH_EVENT_TYPES);
export type WorkbenchEventType = z.infer<typeof workbenchEventTypeSchema>;

const text = z.string().min(1);
const at = z.iso.datetime({ offset: true });

export const OBJECTIVE_MAX_LENGTH = 4000;

export const workbenchCreateSchema = z.strictObject({
  objective: z.string().trim().min(1).max(OBJECTIVE_MAX_LENGTH),
  clientRequestId: z.uuid(),
});
export type WorkbenchCreate = z.infer<typeof workbenchCreateSchema>;

export const workbenchDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  expectedPayloadSha256: sha256DigestSchema,
});
export type WorkbenchDecision = z.infer<typeof workbenchDecisionSchema>;

export const workbenchTaskSummarySchema = z.strictObject({
  id: z.uuid(),
  title: text,
  objective: text,
  status: workbenchStatusSchema,
  version: z.number().int().positive(),
  createdAt: at,
  updatedAt: at,
  llmMode: z.enum(['vertex', 'stub']),
  modelId: text,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type WorkbenchTaskSummary = z.infer<typeof workbenchTaskSummarySchema>;

export const workbenchEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  type: workbenchEventTypeSchema,
  summary: text,
  at,
  durationMs: z.number().int().nonnegative().nullable(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type WorkbenchEvent = z.infer<typeof workbenchEventSchema>;

export const workbenchEvidenceSchema = z.strictObject({
  id: text,
  ordinal: z.number().int().positive(),
  sourceId: text,
  title: text,
  excerpt: text,
  url: z.string().nullable(),
  modifiedAt: at,
  retrievedAt: at,
  provenance: text,
});
export type WorkbenchEvidence = z.infer<typeof workbenchEvidenceSchema>;

const claimSchema = z.strictObject({ text, evidenceIds: z.array(text).min(1) });

export const workbenchReportSchema = z.strictObject({
  title: text,
  summary: text,
  recurringCauses: z.array(
    z.strictObject({ cause: text, explanation: text, evidenceIds: z.array(text).min(1) }),
  ),
  incidents: z.array(z.strictObject({ evidenceId: text, oneLine: text })),
  recommendations: z.array(claimSchema),
  gaps: z.array(text),
});
export type WorkbenchReport = z.infer<typeof workbenchReportSchema>;

export type ReportItem = {
  /** Set for recurring causes: the cause, rendered ahead of the explanation in `text`. */
  readonly title?: string;
  readonly text: string;
  readonly evidenceIds: readonly string[];
};

export type ReportSection = {
  readonly kind: 'summary' | 'causes' | 'incidents' | 'recommendations' | 'gaps';
  readonly heading: string;
  readonly items: readonly ReportItem[];
};

/** The one section order every rendering of a report follows; empty sections are included. */
export function reportSections(report: WorkbenchReport): readonly ReportSection[] {
  return [
    { kind: 'summary', heading: 'Summary', items: [{ text: report.summary, evidenceIds: [] }] },
    {
      kind: 'causes',
      heading: 'Recurring causes',
      items: report.recurringCauses.map((item) => ({
        title: item.cause,
        text: item.explanation,
        evidenceIds: item.evidenceIds,
      })),
    },
    {
      kind: 'incidents',
      heading: 'Incidents reviewed',
      items: report.incidents.map((item) => ({
        text: item.oneLine,
        evidenceIds: [item.evidenceId],
      })),
    },
    {
      kind: 'recommendations',
      heading: 'Recommendations',
      items: report.recommendations.map((item) => ({
        text: item.text,
        evidenceIds: item.evidenceIds,
      })),
    },
    {
      kind: 'gaps',
      heading: 'Gaps and caveats',
      items: report.gaps.map((gap) => ({ text: gap, evidenceIds: [] })),
    },
  ];
}

export function citedEvidenceIds(report: WorkbenchReport): ReadonlySet<string> {
  return new Set(
    reportSections(report).flatMap((section) => section.items.flatMap((item) => item.evidenceIds)),
  );
}

/** Same-origin fixture paths or https links without credentials; anything else becomes null. */
export function safeWorkbenchUrl(url: string | null): string | null {
  if (url === null) return null;
  if (/^\/fixtures\/(drive|docs)\/[a-z0-9-]+$/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export const workbenchModelCallSchema = z.strictObject({
  mode: z.enum(['vertex', 'stub']),
  modelId: text,
  modelVersion: text,
  responseId: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  at,
});
export type WorkbenchModelCall = z.infer<typeof workbenchModelCallSchema>;

export const workbenchArtifactSchema = z.strictObject({
  report: workbenchReportSchema,
  model: workbenchModelCallSchema,
  droppedCitations: z.number().int().nonnegative(),
  createdAt: at,
});
export type WorkbenchArtifact = z.infer<typeof workbenchArtifactSchema>;

export const workbenchActionProposalSchema = z.strictObject({
  tool: z.literal('google_docs.create'),
  simulated: z.boolean(),
  destination: text,
  account: text,
  scope: text,
  documentTitle: text,
  contentPreview: text,
  wordCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  risks: z.array(text),
});
export type WorkbenchActionProposal = z.infer<typeof workbenchActionProposalSchema>;

export const workbenchApprovalSchema = z.strictObject({
  id: z.uuid(),
  state: z.enum(['pending', 'approved', 'rejected', 'void']),
  proposal: workbenchActionProposalSchema,
  payloadSha256: sha256DigestSchema,
  requestedAt: at,
  expiresAt: at,
  decidedBy: z.string().nullable(),
  decidedAt: at.nullable(),
});
export type WorkbenchApproval = z.infer<typeof workbenchApprovalSchema>;

export const workbenchActionSchema = z.strictObject({
  status: z.enum(['intended', 'succeeded', 'failed', 'uncertain']),
  simulated: z.boolean(),
  attempts: z.number().int().nonnegative(),
  externalId: z.string().nullable(),
  externalUrl: z.string().nullable(),
  updatedAt: at,
});
export type WorkbenchAction = z.infer<typeof workbenchActionSchema>;

export const workbenchTaskDetailSchema = z.strictObject({
  apiVersion: z.literal(WORKBENCH_API_VERSION),
  task: workbenchTaskSummarySchema,
  events: z.array(workbenchEventSchema),
  evidence: z.array(workbenchEvidenceSchema),
  artifact: workbenchArtifactSchema.nullable(),
  approval: workbenchApprovalSchema.nullable(),
  action: workbenchActionSchema.nullable(),
});
export type WorkbenchTaskDetail = z.infer<typeof workbenchTaskDetailSchema>;

export const workbenchTaskListSchema = z.strictObject({
  apiVersion: z.literal(WORKBENCH_API_VERSION),
  tasks: z.array(workbenchTaskSummarySchema),
});
export type WorkbenchTaskList = z.infer<typeof workbenchTaskListSchema>;

export const workbenchReadinessSchema = z.strictObject({
  apiVersion: z.literal(WORKBENCH_API_VERSION),
  identity: z.strictObject({ sub: text, email: z.string().nullable(), localOnly: z.boolean() }),
  /** The caller's tasks in waiting_approval, so the shell badge needs no task list. */
  pendingApprovals: z.number().int().nonnegative(),
  model: z.strictObject({
    mode: z.enum(['vertex', 'stub']),
    state: z.enum(['ready', 'unverified', 'not_configured', 'error']),
    modelId: z.string(),
    project: z.string(),
    location: z.string(),
    credentials: z.enum(['present', 'ambient', 'missing', 'not_required']),
    lastCall: z
      .strictObject({ at, outcome: text, latencyMs: z.number().int().nullable() })
      .nullable(),
    callsUsed: z.number().int().nonnegative(),
    callsLimit: z.number().int().nonnegative(),
    errorCode: z.string().nullable(),
    remediation: z.string().nullable(),
  }),
  workspace: z.strictObject({
    adapter: z.literal('fixture'),
    simulated: z.literal(true),
    readScope: text,
    writeScope: text,
    note: text,
  }),
});
export type WorkbenchReadiness = z.infer<typeof workbenchReadinessSchema>;

export const workbenchErrorSchema = z.strictObject({
  error: text,
  message: z.string().optional(),
});
export type WorkbenchError = z.infer<typeof workbenchErrorSchema>;
