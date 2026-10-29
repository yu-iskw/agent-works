import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import {
  TEAMWORK_API_VERSION,
  UUID_PATTERN,
  actionDecisionSchema,
  connectionCompleteSchema,
  conversationPostSchema,
  followUpSchema,
  importSchema,
  missingDecisionSchema,
  planDecisionSchema,
  planEditSchema,
  planReplanSchema,
  publishRequestSchema,
  skillAttachSchema,
  skillCustomizeSchema,
  taskCreateSchema,
  teammateCreateSchema,
  teammateUpdateSchema,
} from '@agent-works/domain/teamwork';

import { Unauthenticated, Unavailable } from '../auth/iap.js';
import { headerValue } from '../http.js';

import {
  createStarterTeam,
  createTeammate,
  customizeSkill,
  exportTeammate,
  getTeammate,
  importTeammate,
  listSkills,
  listTeammates,
  listTemplates,
  setSkill,
  skillVersions,
  updateTeammate,
} from './catalog.js';
import {
  completeConnection,
  connections,
  disconnect,
  startConnection,
  tokenSource,
} from './connections.js';
import { Conflict, audit } from './context.js';
import { conversation, postToConversation } from './conversations.js';
import {
  cancelTask,
  createTask,
  decideAction,
  decideMissing,
  decidePlan,
  dismissInbox,
  editPlan,
  followUp,
  inbox,
  listTasks,
  preparePublish,
  reconcileTask,
  replan,
  retryTask,
  taskDetail,
} from './tasks.js';

import type { Deps, Member, Reply, Request } from './context.js';
import type { VerifyAssertion } from '../auth/iap.js';
import type * as z from 'zod';

const reply = (status: number, body: unknown): Reply => ({
  status,
  body: { apiVersion: TEAMWORK_API_VERSION, ...(body as object) },
});
const notFound = { status: 404, body: { error: 'not_found' } };

type Handler = (
  ctx: { deps: Deps; member: Member; request: Request },
  params: readonly string[],
) => Promise<Reply>;
type Entry = { readonly method: 'GET' | 'POST'; readonly path: RegExp; readonly handle: Handler };

const uuid = `(${UUID_PATTERN})`;
// eslint-disable-next-line security/detect-non-literal-regexp
const p = (pattern: string) => new RegExp(`^/v1/teamwork${pattern}$`);

function body<T>(schema: z.ZodType<T>, request: Request): T {
  let raw: unknown;
  try {
    raw = request.body.length === 0 ? {} : (JSON.parse(request.body.toString('utf8')) as unknown);
  } catch {
    throw new Conflict('invalid_request', 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Conflict('invalid_request', 400);
  return parsed.data;
}

const provider = (value: string | undefined): 'google' | 'github' => {
  if (value === 'google' || value === 'github') return value;
  throw new Conflict('not_found', 404);
};

export type Readiness = (member: Member) => Promise<unknown>;

function catalogRoutes(readiness: Readiness): readonly Entry[] {
  return [
    {
      method: 'GET',
      path: p('/me'),
      handle: async ({ member }) => reply(200, await readiness(member)),
    },
    {
      method: 'GET',
      path: p('/catalog'),
      handle: async ({ deps: d, member }) =>
        reply(200, {
          templates: await listTemplates(d, member),
          skills: await listSkills(d, member),
        }),
    },
    {
      method: 'GET',
      path: p(`/skills/${uuid}`),
      handle: async ({ deps: d, member }, [id]) => {
        const versions = await skillVersions(d, member, id);
        return versions.length === 0 ? notFound : reply(200, { versions });
      },
    },
    {
      method: 'POST',
      path: p('/skills/customize'),
      handle: async ({ deps: d, member, request }) =>
        reply(201, { skill: await customizeSkill(d, member, body(skillCustomizeSchema, request)) }),
    },
    {
      method: 'GET',
      path: p('/teammates'),
      handle: async ({ deps: d, member }) =>
        reply(200, { teammates: await listTeammates(d, member) }),
    },
    {
      method: 'POST',
      path: p('/teammates'),
      handle: async ({ deps: d, member, request }) =>
        reply(201, {
          teammate: await createTeammate(d, member, body(teammateCreateSchema, request)),
        }),
    },
    {
      method: 'POST',
      path: p('/teammates/starter'),
      handle: async ({ deps: d, member }) =>
        reply(200, { teammates: await createStarterTeam(d, member) }),
    },
    {
      method: 'GET',
      path: p(`/teammates/${uuid}`),
      handle: async ({ deps: d, member }, [id]) => {
        const teammate = await getTeammate(d, member, id);
        if (teammate === undefined) return notFound;
        return reply(200, { teammate, conversation: await conversation(d, member, teammate.id) });
      },
    },
    {
      method: 'POST',
      path: p(`/teammates/${uuid}`),
      handle: async ({ deps: d, member, request }, [id]) =>
        reply(200, {
          teammate: await updateTeammate(d, member, id, body(teammateUpdateSchema, request)),
        }),
    },
    {
      method: 'POST',
      path: p(`/teammates/${uuid}/skills`),
      handle: async ({ deps: d, member, request }, [id]) =>
        reply(200, { teammate: await setSkill(d, member, id, body(skillAttachSchema, request)) }),
    },
    {
      method: 'GET',
      path: p(`/teammates/${uuid}/export`),
      handle: async ({ deps: d, member }, [id]) =>
        reply(200, { export: await exportTeammate(d, member, id) }),
    },
    {
      method: 'POST',
      path: p('/import'),
      handle: async ({ deps: d, member, request }) => {
        const input = body(importSchema, request);
        return reply(201, await importTeammate(d, member, input.definition, input.clientRequestId));
      },
    },
    {
      method: 'POST',
      path: p(`/conversations/${uuid}/messages`),
      handle: async ({ deps: d, member, request }, [id]) => {
        await postToConversation(d, member, id, body(conversationPostSchema, request));
        return reply(202, { accepted: true });
      },
    },
  ];
}

const workRoutes = (): readonly Entry[] => [
  {
    method: 'GET',
    path: p('/tasks'),
    handle: async ({ deps: d, member }) => reply(200, { tasks: await listTasks(d, member) }),
  },
  {
    method: 'POST',
    path: p('/tasks'),
    handle: async ({ deps: d, member, request }) => {
      const { task, created } = await createTask(d, member, body(taskCreateSchema, request));
      return reply(created ? 201 : 200, { task });
    },
  },
  {
    method: 'GET',
    path: p(`/tasks/${uuid}`),
    handle: async ({ deps: d, member }, [id]) => {
      const detail = await taskDetail(d, member, id);
      return detail === undefined ? notFound : { status: 200, body: detail };
    },
  },
  {
    method: 'GET',
    path: p(`/tasks/${uuid}/version`),
    handle: async ({ deps: d, member }, [id]) => {
      const row = (
        await d.sql<
          { version: number; status: string }[]
        >`select version, status from wb_tasks where id = ${id} and kind = 'teamwork' and owner_sub = ${member.sub}`
      ).at(0);
      return row === undefined
        ? notFound
        : reply(200, { segment: d.config.segment, version: row.version, status: row.status });
    },
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/plan/decision`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, { task: await decidePlan(d, member, id, body(planDecisionSchema, request)) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/plan/edit`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, { task: await editPlan(d, member, id, body(planEditSchema, request)) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/plan/replan`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, { task: await replan(d, member, id, body(planReplanSchema, request).feedback) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/follow-up`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, { task: await followUp(d, member, id, body(followUpSchema, request)) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/missing`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, {
        task: await decideMissing(d, member, id, body(missingDecisionSchema, request)),
      }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/cancel`),
    handle: async ({ deps: d, member }, [id]) =>
      reply(200, { task: await cancelTask(d, member, id) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/retry`),
    handle: async ({ deps: d, member }, [id]) =>
      reply(200, { task: await retryTask(d, member, id) }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/reconcile`),
    handle: async ({ deps: d, member }, [id]) => {
      const token = tokenSource(d, member.sub);
      return reply(200, {
        task: await reconcileTask(d, member, id, (key) => d.sources.findPublished(token, key)),
      });
    },
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/publish`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, {
        task: await preparePublish(d, member, id, body(publishRequestSchema, request).revision),
      }),
  },
  {
    method: 'POST',
    path: p(`/tasks/${uuid}/action`),
    handle: async ({ deps: d, member, request }, [id]) =>
      reply(200, {
        task: await decideAction(d, member, id, body(actionDecisionSchema, request)),
      }),
  },
  {
    method: 'GET',
    path: p('/inbox'),
    handle: async ({ deps: d, member }) => reply(200, { items: await inbox(d, member) }),
  },
  {
    method: 'POST',
    path: p(`/inbox/${uuid}/dismiss`),
    handle: async ({ deps: d, member }, [id]) => {
      await dismissInbox(d, member, id);
      return reply(200, { dismissed: true });
    },
  },
  {
    method: 'GET',
    path: p('/connections'),
    handle: async ({ deps: d, member }) =>
      reply(200, { connections: await connections(d, member) }),
  },
  {
    method: 'POST',
    path: p('/connections/(google|github)/start'),
    handle: async ({ deps: d, member }, [name]) =>
      reply(200, { url: await startConnection(d, member, provider(name)) }),
  },
  {
    method: 'POST',
    path: p('/connections/(google|github)/complete'),
    handle: async ({ deps: d, member, request }, [name]) =>
      reply(200, {
        connection: await completeConnection(
          d,
          member,
          provider(name),
          body(connectionCompleteSchema, request),
        ),
      }),
  },
  {
    method: 'POST',
    path: p('/connections/(google|github)/disconnect'),
    handle: async ({ deps: d, member }, [name]) => {
      await disconnect(d, member, provider(name));
      return reply(200, { connections: await connections(d, member) });
    },
  },
  {
    method: 'GET',
    path: p('/fixture-docs/(fxdoc-[a-f0-9]{16})'),
    handle: async ({ deps: d, member }, [docId]) => {
      const rows = await d.sql<{ title: string; body: { markdown: string }; created_at: Date }[]>`
          select f.title, f.body, f.created_at from wb_fixture_docs f
          join wb_actions ac on ac.idempotency_key = f.idempotency_key join wb_tasks t on t.id = ac.task_id
          where f.doc_id = ${docId} and t.owner_sub = ${member.sub}
        `;
      const row = rows.at(0);
      return row === undefined
        ? notFound
        : reply(200, {
            title: row.title,
            markdown: row.body.markdown,
            createdAt: row.created_at.toISOString(),
            fixture: true,
          });
    },
  },
];

export function createRoutes(deps: Deps, verify: VerifyAssertion, readiness: Readiness) {
  const table = [...catalogRoutes(readiness), ...workRoutes()];

  /**
   * Every request carries a short-lived member assertion minted by web for this segment's
   * audience. Membership is checked here, server-side, on every call; another member's ids 404.
   */
  async function authenticate(request: Request): Promise<Member | Reply> {
    try {
      const caller = await verify(headerValue(request.headers, IAP_ASSERTION_HEADER));
      const email = caller.email?.toLowerCase();
      if (email === undefined || !deps.config.members.has(email)) {
        await audit(deps, deps.sql, {
          ownerSub: caller.sub,
          action: 'segment.access',
          outcome: 'not_member',
        });
        return { status: 403, body: { error: 'not_member' } };
      }
      return { sub: caller.sub, email };
    } catch (error) {
      if (error instanceof Unauthenticated)
        return { status: 401, body: { error: 'unauthenticated' } };
      if (error instanceof Unavailable)
        return { status: 503, body: { error: 'identity_unavailable' } };
      throw error;
    }
  }

  async function dispatch(
    entry: Entry,
    member: Member,
    request: Request,
    params: readonly string[],
  ): Promise<Reply> {
    try {
      return await entry.handle({ deps, member, request }, params);
    } catch (error) {
      if (error instanceof Conflict) return { status: error.status, body: { error: error.code } };
      throw error;
    }
  }

  return async (request: Request): Promise<Reply> => {
    const member = await authenticate(request);
    if ('status' in member) return member;
    if (
      request.method === 'POST' &&
      (headerValue(request.headers, 'x-csrf-token') ?? '').length === 0
    )
      return { status: 403, body: { error: 'csrf_missing' } };
    for (const entry of table) {
      if (entry.method !== request.method) continue;
      const match = entry.path.exec(request.path);
      if (match !== null) return dispatch(entry, member, request, match.slice(1));
    }
    return notFound;
  };
}
