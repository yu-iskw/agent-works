// JSON routes for task detail, attachments and task commands. Bodies are parsed with the domain
// schemas before they reach the segment, which re-checks every digest and version itself; the
// BFF passes member-supplied digests through and never computes one.

import {
  actionDecisionSchema,
  attachmentViewSchema,
  followUpSchema,
  missingDecisionSchema,
  planDecisionSchema,
  planEditSchema,
  planReplanSchema,
  publishRequestSchema,
} from '@agent-works/domain/teamwork';
import { z } from 'zod';

import { TASK_COMMANDS } from '../../shared/contract.js';

import { securityHeaders } from './headers.js';

import type { TaskCommand } from '../../shared/contract.js';
import type { ApiResult, SegmentClient } from '../m1/api.js';
import type { Segment } from '../m1/config.js';
import type { Session } from '../m1/identity.js';
import type { ServerResponse } from 'node:http';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The slice of the workspace request these routes read; structurally satisfied by routes.ts. */
type TaskReq = {
  readonly deps: {
    readonly api: Pick<SegmentClient, 'task' | 'attachment' | 'command' | 'graph' | 'graphCommand'>;
  };
  readonly response: ServerResponse;
  readonly session: Session;
  readonly segment: Segment;
  readonly m: RegExpExecArray;
};

export type TaskRoute = {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly handle: (req: TaskReq, body: unknown) => Promise<void>;
};

const EMPTY = z.strictObject({}).optional();

/** One body schema per command; commands without a body accept `{}` or nothing. */
const BODY_SCHEMAS: Readonly<Record<TaskCommand, z.ZodType>> = {
  'plan/decision': planDecisionSchema,
  'plan/edit': planEditSchema,
  'plan/replan': planReplanSchema,
  'follow-up': followUpSchema,
  missing: missingDecisionSchema,
  cancel: EMPTY,
  retry: EMPTY,
  reconcile: EMPTY,
  publish: publishRequestSchema,
  action: actionDecisionSchema,
};

/** Segment replies carry `apiVersion`; the BFF contract and the strict view schemas do not. */
const withoutVersion = <T extends object>(value: T): Omit<T, 'apiVersion'> =>
  Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'apiVersion')) as Omit<
    T,
    'apiVersion'
  >;

const isCommand = (value: string): value is TaskCommand =>
  (TASK_COMMANDS as readonly string[]).includes(value);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    ...securityHeaders,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function send<T extends object>(req: TaskReq, result: ApiResult<T>): void {
  if (!result.ok)
    return json(req.response, result.status >= 500 ? 502 : result.status, {
      segment: req.segment.id,
      error: result.error,
    });
  json(req.response, 200, { ...result.value, segment: req.segment.id });
}

const bad = (req: TaskReq) =>
  json(req.response, 400, { segment: req.segment.id, error: 'bad_request' });

export const TASK_ROUTES: readonly TaskRoute[] = [
  {
    method: 'GET',
    pattern: new RegExp(`^/tasks/(${UUID})$`),
    handle: async (req) => {
      const result = await req.deps.api.task(req.session, req.segment.id, req.m[1]);
      if (!result.ok) return send(req, result);
      send(req, { ok: true, value: withoutVersion(result.value) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/attachments/(${UUID})$`),
    handle: async (req) => {
      const result = await req.deps.api.attachment(req.session, req.segment.id, req.m[1]);
      if (!result.ok) return send(req, result);
      // The segment answers `{ attachment, text }`; only the view travels to the browser.
      const raw = result.value;
      const envelope =
        typeof raw === 'object' && raw !== null ? (raw as { attachment?: unknown }) : {};
      const parsed = attachmentViewSchema.safeParse(
        typeof envelope.attachment === 'object' && envelope.attachment !== null
          ? envelope.attachment
          : withoutVersion(envelope),
      );
      send(
        req,
        parsed.success
          ? { ok: true, value: { attachment: parsed.data } }
          : { ok: false, status: 502, error: 'bad_contract' },
      );
    },
  },
  {
    method: 'POST',
    // Built from the closed TASK_COMMANDS table and the fixed UUID pattern, never from input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    pattern: new RegExp(`^/tasks/(${UUID})/(${TASK_COMMANDS.join('|')})$`),
    handle: async (req, body) => {
      const command = req.m[2];
      if (!isCommand(command)) return bad(req);
      // `command` is one of the closed TASK_COMMANDS.
      // eslint-disable-next-line security/detect-object-injection
      const parsed = BODY_SCHEMAS[command].safeParse(body);
      if (!parsed.success) return bad(req);
      send(
        req,
        await req.deps.api.command(
          req.session,
          req.segment.id,
          req.m[1],
          command,
          parsed.data ?? {},
        ),
      );
    },
  },
];
