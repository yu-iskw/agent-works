// Composer contract shared by the BFF and the browser: context chips, the menu context the server
// assembles, follow-up targets, the local task draft, and the file rules the client checks before
// an upload. Types only plus pure functions; no zod, so the client bundle stays zod-free.

import type { Appearance } from './contract.js';
import type {
  AttachmentMediaType,
  Capability,
  CapabilityState,
  MetricsScope,
  SourceKind,
  TeamworkStatus,
  Workflow,
} from '@agent-works/domain/teamwork';

// Mirrors the domain's attachment limits; compose-routes.test.ts pins them equal.
export const FILE_MAX_BYTES = 200 * 1024;
export const FILE_MAX_PER_MESSAGE = 5;
export const FILE_NAME_MAX = 120;

/** Extension to media type. The browser's `File.type` is unreliable for .md, so the name decides. */
const FILE_EXTENSIONS: Partial<Readonly<Record<string, AttachmentMediaType>>> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};
export const FILE_ACCEPT = '.txt,.md,.csv,.json';

type FileStatus = 'uploading' | 'ready' | 'failed';

export type FileChip = {
  readonly kind: 'file';
  /** Minted in the browser; stable across retries so the chip keeps its place. */
  readonly localId: string;
  readonly name: string;
  readonly mediaType: AttachmentMediaType;
  readonly sizeBytes: number;
  readonly status: FileStatus;
  /** Set once the segment stored the file. */
  readonly attachmentId: string | null;
  readonly error: string | null;
  readonly preview: string | null;
  readonly lines: number | null;
  readonly sha256: string | null;
};

type TeammateChip = {
  readonly kind: 'teammate';
  readonly id: string;
  readonly name: string;
  readonly role: string;
};

type SkillChip = { readonly kind: 'skill'; readonly id: string; readonly name: string };

type SourceChip = {
  readonly kind: 'source';
  readonly source: SourceKind;
  readonly name: string;
};

export type ContextChip = FileChip | TeammateChip | SkillChip | SourceChip;

export function chipKey(chip: ContextChip): string {
  switch (chip.kind) {
    case 'file':
      return `file:${chip.localId}`;
    case 'teammate':
      return `teammate:${chip.id}`;
    case 'skill':
      return `skill:${chip.id}`;
    case 'source':
      return `source:${chip.source}`;
  }
}

/** Chips that mean work rather than chat: chat cannot read sources, skills or other teammates. */
export const isWorkChip = (chip: ContextChip): boolean => chip.kind !== 'file';

// ---- menu context, assembled by GET /api/s/<seg>/composer ----

export type MenuTeammate = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly appearance: Appearance;
  readonly templateName: string;
  readonly skills: readonly { readonly id: string; readonly name: string }[];
  readonly capabilities: readonly CapabilityState[];
};

type MenuSkill = {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly workflows: readonly Workflow[];
  /** Teammates of the member this skill is attached to. */
  readonly attachedTo: readonly string[];
  /** Whether a teammate holding it may own a result: the segment's rule is more than one output section. */
  readonly synthesizes: boolean;
};

export type MenuSource = {
  readonly kind: SourceKind;
  readonly name: string;
  readonly capability: Capability;
  readonly workflows: readonly Workflow[];
  /** Null when the segment and membership allow it; otherwise the member-facing reason. */
  readonly unavailable: string | null;
};

export const WORKFLOWS = ['research_brief', 'metrics_explanation', 'engineering_proposal'] as const;

/** Sources each workflow may use; mirrors the segment's table, which rejects any other source. */
export const WORKFLOW_SOURCES: Readonly<Record<Workflow, readonly SourceKind[]>> = {
  research_brief: ['drive_research', 'member_file'],
  metrics_explanation: ['bigquery_metrics', 'drive_context', 'member_file'],
  engineering_proposal: ['github_issue', 'github_code', 'member_file'],
};

export const WORKFLOW_LABELS: Readonly<Record<Workflow, string>> = {
  research_brief: 'Research brief',
  metrics_explanation: 'Metrics explanation',
  engineering_proposal: 'Engineering proposal',
};

export type ComposerContext = {
  readonly segment: string;
  readonly teammates: readonly MenuTeammate[];
  readonly skills: readonly MenuSkill[];
  readonly sources: readonly MenuSource[];
  readonly repositories: readonly string[];
  readonly issue: number | null;
};

// ---- follow-up targets, from GET /api/s/<seg>/conversations/<id>/targets ----

type OpenQuestion = {
  readonly assignmentId: string;
  readonly teammateName: string;
  readonly question: string;
};

export type TargetTask = {
  readonly taskId: string;
  readonly title: string;
  readonly status: TeamworkStatus;
  readonly version: number;
  readonly latestRevision: number;
  readonly openQuestions: readonly OpenQuestion[];
};

export type FollowUpTargets = { readonly segment: string; readonly tasks: readonly TargetTask[] };

/** Where one Send goes. `teammate` is plain chat; the others map to POST /tasks/:id/follow-up. */
export type FollowUpTarget =
  | { readonly kind: 'teammate' }
  | {
      readonly kind: 'answer';
      readonly taskId: string;
      readonly assignmentId: string;
      readonly teammateName: string;
    }
  | {
      readonly kind: 'revise';
      readonly taskId: string;
      readonly revision: number;
      readonly title: string;
    }
  | { readonly kind: 'question'; readonly taskId: string; readonly title: string };

export const targetKey = (target: FollowUpTarget): string =>
  target.kind === 'teammate'
    ? 'teammate'
    : target.kind === 'answer'
      ? `answer:${target.assignmentId}`
      : `${target.kind}:${target.taskId}`;

// ---- the local task draft (a card in the conversation until Start) ----

export type Specialist = {
  readonly teammateId: string;
  readonly name: string;
  readonly role: string;
  readonly brief: string;
  readonly sources: readonly SourceKind[];
};

export type TaskDraft = {
  /** Stable across Start retries so the segment dedupes a double submit. */
  readonly clientRequestId: string;
  readonly conversationId: string;
  readonly objective: string;
  readonly workflow: Workflow;
  readonly mode: 'manual' | 'coordinated';
  readonly resultOwnerId: string;
  readonly specialists: readonly Specialist[];
  readonly attachments: readonly { readonly id: string; readonly name: string }[];
  readonly repository: string | null;
  readonly issueNumber: number | null;
  readonly metrics: MetricsScope | null;
  readonly expanded: boolean;
};

// ---- file pre-check, before any byte is read ----

export type FileCheck =
  | { readonly ok: true; readonly mediaType: AttachmentMediaType }
  | { readonly ok: false; readonly message: string };

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Type, size and count rules with the message the member reads; the server re-checks the bytes. */
export function checkFile(
  file: { readonly name: string; readonly size: number },
  alreadyAttached: number,
): FileCheck {
  const extension = extensionOf(file.name);
  // Extensions are looked up in a fixed table of four entries.
  // eslint-disable-next-line security/detect-object-injection
  const mediaType = FILE_EXTENSIONS[extension];
  if (mediaType === undefined) {
    const what =
      extension === 'pdf' ? 'PDF' : extension === '' ? 'This file type' : `.${extension}`;
    return {
      ok: false,
      message: `${what} is not supported yet; paste the text or upload .txt, .md, .csv or .json.`,
    };
  }
  if (file.name.length > FILE_NAME_MAX)
    return { ok: false, message: `The file name is too long (limit ${FILE_NAME_MAX} characters).` };
  if (file.size > FILE_MAX_BYTES)
    return {
      ok: false,
      message: `${file.name} is ${kb(file.size)}; the limit is ${kb(FILE_MAX_BYTES)} per file.`,
    };
  if (alreadyAttached >= FILE_MAX_PER_MESSAGE)
    return { ok: false, message: `Up to ${FILE_MAX_PER_MESSAGE} files per message.` };
  return { ok: true, mediaType };
}

/** UTF-8 byte length without allocating a buffer. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
