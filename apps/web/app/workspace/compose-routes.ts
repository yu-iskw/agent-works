// JSON routes behind the composer: the menu context, follow-up targets, member file upload and
// removal, and task creation. Bodies are parsed with the domain schemas before they reach the
// segment; the segment re-checks ownership, limits and capabilities itself.

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_NAME_MAX,
  SOURCE_CAPABILITY,
  SOURCE_KINDS,
  taskCreateSchema,
} from '@agent-works/domain/teamwork';
import { z } from 'zod';

import { WORKFLOW_SOURCES, utf8Length } from '../../shared/composer.js';
import { sourceLabel } from '../m1/labels.js';

import { securityHeaders } from './headers.js';

import type { JsonReq, JsonRoute } from './routes.js';
import type {
  ComposerContext,
  FollowUpTargets,
  MenuSource,
  TargetTask,
} from '../../shared/composer.js';
import type { Readiness } from '../m1/api.js';
import type { Capability, SourceKind, TaskDetail } from '@agent-works/domain/teamwork';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
const MAX_TARGET_TASKS = 5;
/** JSON escaping can quadruple the text; the byte rule is checked on the decoded string. */
const UPLOAD_MAX_BODY = ATTACHMENT_MAX_BYTES * 4 + 4096;

function send(req: JsonReq, status: number, body: object): void {
  req.response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  req.response.end(JSON.stringify({ segment: req.segment.id, ...body }));
}

const refuse = (req: JsonReq, result: { status: number; error: string; detail?: string }): void =>
  send(req, result.status >= 500 ? 502 : result.status, {
    error: result.error,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  });

/** `text/csv; charset=utf-8` is CSV: the segment accepts parameters, so the BFF must too. */
const baseMediaType = (value: string): string => value.split(';')[0].trim().toLowerCase();

// ---- sources the segment and membership allow ----

const PROVIDER: Record<Capability, string> = {
  'drive.read': 'Google Drive',
  'docs.publish': 'Google Docs',
  'bigquery.query': 'BigQuery',
  'github.read': 'GitHub',
  'files.read': 'file reading',
};

function unavailableReason(kind: SourceKind, me: Readiness): string | null {
  // `kind` is the closed SourceKind enum.
  // eslint-disable-next-line security/detect-object-injection
  const capability = SOURCE_CAPABILITY[kind];
  // eslint-disable-next-line security/detect-object-injection
  const provider = PROVIDER[capability];
  if (capability !== 'files.read' && !me.capabilities.includes(capability))
    return `Needs ${provider} — not available in this segment`;
  // Fixture sources read seed files; the live folder, dataset and allowlist do not apply.
  if (me.sourceMode === 'fixture') return null;
  if (capability === 'drive.read' && !me.sources.driveConfigured)
    return `Needs ${provider} — not configured in this segment`;
  if (capability === 'bigquery.query' && me.sources.dataset === null)
    return `Needs ${provider} — no dataset configured in this segment`;
  if (capability === 'github.read' && me.sources.repositories.length === 0)
    return `Needs ${provider} — no repository allowlisted in this segment`;
  return null;
}

export function menuSources(me: Readiness): readonly MenuSource[] {
  return SOURCE_KINDS.map((kind) => ({
    kind,
    name: sourceLabel(kind),
    // eslint-disable-next-line security/detect-object-injection
    capability: SOURCE_CAPABILITY[kind],
    workflows: (Object.keys(WORKFLOW_SOURCES) as (keyof typeof WORKFLOW_SOURCES)[]).filter((w) =>
      // eslint-disable-next-line security/detect-object-injection
      WORKFLOW_SOURCES[w].includes(kind),
    ),
    unavailable: unavailableReason(kind, me),
  }));
}

/** One follow-up target per task: its open questions and whether a result can be revised. */
export function targetOf(detail: TaskDetail): TargetTask {
  return {
    taskId: detail.task.id,
    title: detail.task.title,
    status: detail.task.status,
    version: detail.task.version,
    latestRevision: detail.task.latestRevision,
    openQuestions: detail.assignments.flatMap((a) =>
      a.status === 'needs_input' && a.question !== null
        ? [{ assignmentId: a.id, teammateName: a.teammateName, question: a.question }]
        : [],
    ),
  };
}

const uploadSchema = z.strictObject({
  name: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX),
  mediaType: z.string().trim().min(1).max(100),
  text: z.string(),
});

export const composeRoutes: readonly JsonRoute[] = [
  {
    method: 'GET',
    pattern: /^\/composer$/,
    handle: async (req) => {
      const { api } = req.deps;
      const { session, segment } = req;
      const [me, teammates, catalog] = await Promise.all([
        api.me(session, segment.id),
        api.teammates(session, segment.id),
        api.catalog(session, segment.id),
      ]);
      if (!me.ok) return refuse(req, me);
      if (!teammates.ok) return refuse(req, teammates);
      if (!catalog.ok) return refuse(req, catalog);
      const context: Omit<ComposerContext, 'segment'> = {
        teammates: teammates.value.teammates.map((t) => ({
          id: t.id,
          name: t.name,
          role: t.role,
          appearance: t.appearance,
          templateName: t.template.name,
          skills: t.skills.map((s) => ({ id: s.id, name: s.name })),
          capabilities: t.capabilities,
        })),
        skills: catalog.value.skills.map((s) => ({
          id: s.id,
          name: s.definition.name,
          summary: s.definition.summary,
          workflows: s.definition.workflows,
          attachedTo: s.attachedTo,
          synthesizes: s.definition.outputSections.length > 1,
        })),
        sources: menuSources(me.value),
        repositories: me.value.sources.repositories,
        issue: me.value.sources.issue,
      };
      send(req, 200, context);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/conversations/(${UUID})/targets$`),
    handle: async (req) => {
      const ids = (req.url.searchParams.get('tasks') ?? '').split(',').filter((id) => id !== '');
      if (ids.length > MAX_TARGET_TASKS || !ids.every((id) => UUID_RE.test(id)))
        return refuse(req, { status: 400, error: 'bad_request' });
      const details = await Promise.all(
        ids.map((id) => req.deps.api.task(req.session, req.segment.id, id)),
      );
      const tasks = details.flatMap((d) =>
        d.ok && d.value.task.conversationId === req.m[1] ? [targetOf(d.value)] : [],
      );
      const page: Omit<FollowUpTargets, 'segment'> = { tasks };
      send(req, 200, page);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/conversations/(${UUID})/attachments$`),
    maxBody: UPLOAD_MAX_BODY,
    handle: async (req, body) => {
      const parsed = uploadSchema.safeParse(body);
      if (!parsed.success) return refuse(req, { status: 400, error: 'bad_request' });
      const { name, text } = parsed.data;
      const mediaType = baseMediaType(parsed.data.mediaType);
      if (!(ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(mediaType))
        return refuse(req, { status: 400, error: 'unsupported_media_type' });
      if (text.trim() === '') return refuse(req, { status: 400, error: 'attachment_empty' });
      if (utf8Length(text) > ATTACHMENT_MAX_BYTES)
        return refuse(req, { status: 400, error: 'attachment_too_large' });
      const result = await req.deps.api.uploadAttachment(req.session, req.segment.id, req.m[1], {
        name,
        mediaType,
        text,
      });
      if (!result.ok) return refuse(req, result);
      send(req, 201, { attachment: result.value.attachment });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/attachments/(${UUID})/remove$`),
    handle: async (req) => {
      const result = await req.deps.api.removeAttachment(req.session, req.segment.id, req.m[1]);
      if (!result.ok) return refuse(req, result);
      send(req, 200, { removed: result.value.removed });
    },
  },
  {
    method: 'POST',
    pattern: /^\/tasks$/,
    handle: async (req, body) => {
      const parsed = taskCreateSchema.safeParse(body);
      if (!parsed.success) return refuse(req, { status: 400, error: 'bad_request' });
      const result = await req.deps.api.createTask(req.session, req.segment.id, parsed.data);
      if (!result.ok) return refuse(req, result);
      send(req, 201, { task: result.value.task });
    },
  },
];
