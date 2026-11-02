// JSON routes for the bounded lists (Work, Results, Inbox), read markers, the recap and the
// teammate identity editor. Cursors pass through to the segment untouched; the segment scopes
// every list to the member, and every reply echoes the segment.

import { LIST_LIMIT_MAX } from '@agent-works/domain/teamwork';
import { z } from 'zod';

import { ACCENT_IDS, AVATAR_IDS, TASK_FILTERS } from '../../shared/contract.js';

import { securityHeaders } from './headers.js';
import { buildRecap } from './recap.js';

import type { JsonReq, JsonRoute } from './routes.js';
import type { SkillOption, TeammateDetail } from '../../shared/contract.js';
import type { ApiResult } from '../m1/api.js';
import type { SkillView, TeammateView } from '@agent-works/domain/teamwork';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

const listQuerySchema = z.object({
  status: z.enum(TASK_FILTERS).default('all'),
  q: z.string().trim().max(200).default(''),
  cursor: z.string().regex(CURSOR).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(25),
});

const identitySchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(160),
  avatar: z.enum(AVATAR_IDS).nullable(),
  accent: z.enum(ACCENT_IDS).nullable(),
});

const skillSchema = z.strictObject({
  skillId: z.string().uuid(),
  version: z.number().int().positive(),
  attach: z.boolean(),
});

function send(req: JsonReq, status: number, body: object): void {
  req.response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  req.response.end(JSON.stringify({ segment: req.segment.id, ...body }));
}

const refuse = (req: JsonReq, result: { status: number; error: string }): void =>
  send(req, result.status >= 500 ? 502 : result.status, { error: result.error });

/** The segment's own query grammar, rebuilt from validated parts so nothing else passes through. */
function listSearch(req: JsonReq): string | undefined {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(req.url.searchParams));
  if (!parsed.success) return undefined;
  const { status, q, cursor, limit } = parsed.data;
  const params = new URLSearchParams({ limit: String(limit) });
  if (status !== 'all') params.set('status', status);
  if (q !== '') params.set('q', q);
  if (cursor !== undefined) params.set('cursor', cursor);
  return params.toString();
}

function pageRoute<R extends { readonly nextCursor: string | null }>(
  pattern: RegExp,
  load: (req: JsonReq, search: string) => Promise<ApiResult<R>>,
  items: (reply: R) => readonly unknown[],
): JsonRoute {
  return {
    method: 'GET',
    pattern,
    handle: async (req) => {
      const search = listSearch(req);
      if (search === undefined) return refuse(req, { status: 400, error: 'bad_request' });
      const result = await load(req, search);
      if (!result.ok) return refuse(req, result);
      send(req, 200, { items: items(result.value), nextCursor: result.value.nextCursor });
    },
  };
}

/** The catalog's newest version per skill id, marked with whether this teammate has it. */
function skillOptions(
  catalog: readonly SkillView[],
  teammate: TeammateView,
): readonly SkillOption[] {
  const newest = new Map<string, SkillView>();
  for (const skill of catalog) {
    const held = newest.get(skill.id);
    if (held === undefined || held.version < skill.version) newest.set(skill.id, skill);
  }
  const attached = new Set(teammate.skills.map((s) => s.id));
  return [...newest.values()]
    .map((skill) => ({
      id: skill.id,
      version: skill.version,
      name: skill.definition.name,
      summary: skill.definition.summary,
      origin: skill.origin,
      attached: attached.has(skill.id),
    }))
    .sort((a, b) => Number(b.attached) - Number(a.attached) || a.name.localeCompare(b.name));
}

async function detailOf(req: JsonReq, teammate: TeammateView): Promise<ApiResult<TeammateDetail>> {
  const catalog = await req.deps.api.catalog(req.session, req.segment.id);
  if (!catalog.ok) return catalog;
  return {
    ok: true,
    value: {
      segment: req.segment.id,
      id: teammate.id,
      version: teammate.version,
      name: teammate.name,
      role: teammate.role,
      appearance: teammate.appearance,
      template: teammate.template,
      origin: teammate.origin,
      skills: skillOptions(catalog.value.skills, teammate),
      capabilities: teammate.capabilities,
    },
  };
}

async function sendDetail(req: JsonReq, found: ApiResult<{ teammate: TeammateView }>) {
  if (!found.ok) return refuse(req, found);
  const detail = await detailOf(req, found.value.teammate);
  if (!detail.ok) return refuse(req, detail);
  send(req, 200, detail.value);
}

export const listRoutes: readonly JsonRoute[] = [
  pageRoute(
    /^\/tasks$/,
    (req, search) => req.deps.api.taskPage(req.session, req.segment.id, search),
    (reply) => reply.tasks,
  ),
  pageRoute(
    /^\/results$/,
    (req, search) => req.deps.api.resultPage(req.session, req.segment.id, search),
    (reply) => reply.results,
  ),
  pageRoute(
    /^\/inbox$/,
    (req, search) => req.deps.api.inboxPage(req.session, req.segment.id, `state=open&${search}`),
    (reply) => reply.items,
  ),
  {
    method: 'POST',
    pattern: new RegExp(`^/conversations/(${UUID})/read$`),
    handle: async (req, body) => {
      const parsed = z.strictObject({ upToMessageId: z.string().uuid() }).safeParse(body);
      if (!parsed.success) return refuse(req, { status: 400, error: 'bad_request' });
      const result = await req.deps.api.markRead(
        req.session,
        req.segment.id,
        req.m[1],
        parsed.data.upToMessageId,
      );
      if (!result.ok) return refuse(req, result);
      send(req, 200, { read: true });
    },
  },
  {
    method: 'GET',
    pattern: /^\/recap$/,
    handle: async (req) => {
      const { api } = req.deps;
      const [inbox, running, results] = await Promise.all([
        api.inboxPage(req.session, req.segment.id, 'state=open&limit=50'),
        api.taskPage(req.session, req.segment.id, 'status=running&limit=50'),
        api.resultPage(req.session, req.segment.id, 'limit=25'),
      ]);
      if (!inbox.ok) return refuse(req, inbox);
      if (!running.ok) return refuse(req, running);
      if (!results.ok) return refuse(req, results);
      send(
        req,
        200,
        buildRecap(req.segment.id, {
          inbox: inbox.value.items,
          running: running.value.tasks,
          results: results.value.results,
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/teammates/(${UUID})$`),
    handle: async (req) =>
      sendDetail(req, await req.deps.api.teammate(req.session, req.segment.id, req.m[1])),
  },
  {
    // Identity only: instructions are carried over unchanged, so this editor cannot alter behaviour.
    method: 'POST',
    pattern: new RegExp(`^/teammates/(${UUID})$`),
    handle: async (req, body) => {
      const parsed = identitySchema.safeParse(body);
      if (!parsed.success) return refuse(req, { status: 400, error: 'bad_request' });
      const current = await req.deps.api.teammate(req.session, req.segment.id, req.m[1]);
      if (!current.ok) return refuse(req, current);
      const saved = await req.deps.api.updateTeammate(req.session, req.segment.id, req.m[1], {
        ...parsed.data,
        instructions: current.value.teammate.instructions,
      });
      await sendDetail(req, saved);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/teammates/(${UUID})/skills$`),
    handle: async (req, body) => {
      const parsed = skillSchema.safeParse(body);
      if (!parsed.success) return refuse(req, { status: 400, error: 'bad_request' });
      await sendDetail(
        req,
        await req.deps.api.setSkill(req.session, req.segment.id, req.m[1], parsed.data),
      );
    },
  },
];
