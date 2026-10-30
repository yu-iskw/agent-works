import { conversationPageSchema } from '@agent-works/domain/teamwork';
import { z } from 'zod';

import { ACCENT_IDS, AVATAR_IDS } from '../../shared/contract.js';
import { segmentsFor } from '../m1/config.js';

import type {
  ConversationPage,
  MeView,
  TeammateRow,
  TeammatesPage,
} from '../../shared/contract.js';
import type { ApiResult, SegmentClient } from '../m1/api.js';
import type { Segment, WebConfig } from '../m1/config.js';
import type { Session } from '../m1/identity.js';

export type LoaderDeps = { readonly config: WebConfig; readonly api: SegmentClient };

const fail = (status: number, error: string): ApiResult<never> => ({ ok: false, status, error });

export function loadMe(deps: LoaderDeps, session: Session, segment: Segment) {
  return deps.api.me(session, segment.id).then((me): ApiResult<MeView> => {
    if (!me.ok) return me;
    const r = me.value;
    return {
      ok: true,
      value: {
        segment: segment.id,
        segmentName: segment.name,
        segments: segmentsFor(deps.config, session.email).map((s) => ({ id: s.id, name: s.name })),
        member: { email: session.email, name: session.name },
        identity: r.identity,
        sourceMode: r.sourceMode,
        model: {
          modelId: r.model.modelId,
          mode: r.model.mode,
          state: r.model.state,
          callsUsed: r.model.callsUsed,
          callsLimit: r.model.callsLimit,
        },
        readOnly: r.readOnly,
        inboxOpen: Object.values(r.inbox).reduce((sum, n) => sum + n, 0),
      },
    };
  });
}

/** What the shell shows when the segment cannot answer `/me`; every action stays disabled. */
export function unavailableMe(deps: LoaderDeps, session: Session, segment: Segment): MeView {
  return {
    segment: segment.id,
    segmentName: segment.name,
    segments: segmentsFor(deps.config, session.email).map((s) => ({ id: s.id, name: s.name })),
    member: { email: session.email, name: session.name },
    identity: deps.config.identity,
    sourceMode: 'fixture',
    model: { modelId: '', mode: 'stub', state: 'error', callsUsed: 0, callsLimit: 0 },
    readOnly: true,
    inboxOpen: 0,
  };
}

const appearanceSchema = z
  .object({
    avatar: z.enum(AVATAR_IDS).nullable().catch(null),
    accent: z.enum(ACCENT_IDS).nullable().catch(null),
  })
  .catch({ avatar: null, accent: null });

const lastMessageSchema = z
  .object({ text: z.string(), at: z.string(), role: z.enum(['member', 'teammate', 'system']) })
  .nullable()
  .catch(null);

/** Loose on purpose: the segment may or may not carry the activity fields yet. */
const rowSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  conversationId: z.string(),
  updatedAt: z.string(),
  appearance: appearanceSchema.default({ avatar: null, accent: null }),
  lastMessage: lastMessageSchema.default(null),
  unread: z.boolean().catch(false),
  working: z.boolean().catch(false),
  needsAttention: z.boolean().catch(false),
  unreadResult: z.boolean().catch(false),
});

const listSchema = z.union([
  z.looseObject({ items: z.array(rowSchema), nextCursor: z.string().nullable().default(null) }),
  z.looseObject({ teammates: z.array(rowSchema) }).transform((v) => ({
    items: v.teammates,
    nextCursor: null,
  })),
]);

const toRow = (r: z.infer<typeof rowSchema>): TeammateRow => ({
  id: r.id,
  name: r.name,
  role: r.role,
  conversationId: r.conversationId,
  appearance: r.appearance,
  lastMessage: r.lastMessage,
  unread: r.unread,
  working: r.working,
  needsAttention: r.needsAttention,
  unreadResult: r.unreadResult,
  updatedAt: r.updatedAt,
});

export async function loadTeammates(
  deps: LoaderDeps,
  session: Session,
  segment: Segment,
): Promise<ApiResult<TeammatesPage>> {
  const list = await deps.api.teammateRows(session, segment.id);
  if (!list.ok) return list;
  const parsed = listSchema.safeParse(list.value);
  if (!parsed.success) return fail(502, 'bad_contract');
  return {
    ok: true,
    value: {
      segment: segment.id,
      items: parsed.data.items.map(toRow),
      nextCursor: parsed.data.nextCursor,
    },
  };
}

/** Segment replies carry `apiVersion`; the strict page schema does not. */
const withoutVersion = (value: unknown): unknown =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'apiVersion'))
    : value;

export type ConversationQuery = {
  readonly conversationId: string;
  readonly teammateId: string;
  readonly after: string | null;
};

export async function loadTeammateConversation(
  deps: LoaderDeps,
  session: Session,
  segment: Segment,
  teammateId: string,
): Promise<ApiResult<ConversationPage>> {
  const found = await deps.api.teammate(session, segment.id, teammateId);
  if (!found.ok) return found;
  const c = found.value.conversation;
  return {
    ok: true,
    value: {
      segment: segment.id,
      id: c.id,
      teammateId: c.teammateId,
      messages: c.messages,
      nextCursor: null,
      prevCursor: null,
      reply: c.pendingReply ? 'queued' : 'none',
      tasks: c.tasks.map((t) => ({
        id: t.id,
        version: t.version,
        status: t.status,
        title: t.title,
      })),
    },
  };
}

/**
 * Prefers the segment's paged conversation endpoint and falls back to the teammate page while a
 * segment does not serve it; the fallback carries the whole recent history, which the client
 * merges by id.
 */
export async function loadConversation(
  deps: LoaderDeps,
  session: Session,
  segment: Segment,
  query: ConversationQuery,
): Promise<ApiResult<ConversationPage>> {
  const fresh = await deps.api.conversationPage(
    session,
    segment.id,
    query.conversationId,
    query.after,
  );
  if (fresh.ok) {
    const parsed = conversationPageSchema.safeParse(withoutVersion(fresh.value));
    if (parsed.success) return { ok: true, value: { segment: segment.id, ...parsed.data } };
  } else if (fresh.status !== 404 && fresh.status !== 502) return fresh;
  return loadTeammateConversation(deps, session, segment, query.teammateId);
}

export const messagePostSchema = z.strictObject({
  clientRequestId: z.string().uuid(),
  text: z.string().trim().min(1).max(8000),
});
