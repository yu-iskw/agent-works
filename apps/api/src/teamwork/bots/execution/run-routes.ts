import { TEAMWORK_API_VERSION, UUID_PATTERN } from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { Conflict } from '../../context.js';
import { requireOwner } from '../store.js';

import { createRunCommands } from './commands.js';
import { createStartBotRun } from './start.js';
import { bindOwner, runView } from './views.js';

import type { createBotExecution } from './engine.js';
import type { BotTrigger, StartBotRunInput } from './start.js';
import type { ExecutionOptions } from './types.js';
import type { Member, Request } from '../../context.js';
import type { BotRoute } from '../routes.js';

export function requestBody<T>(schema: z.ZodType<T>, request: Request): T {
  try {
    return schema.parse(JSON.parse(request.body.toString('utf8')) as unknown);
  } catch {
    throw new Conflict('invalid_request', 400);
  }
}
export function executionRoute(
  options: ExecutionOptions,
  method: BotRoute['method'],
  path: string,
  action: (member: Member, request: Request, params: readonly string[]) => Promise<object>,
  status = 200,
): BotRoute {
  return {
    method,
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixed route patterns only
    path: new RegExp(`^/v1/teamwork/${path}$`),
    async handle({ member, request }, params) {
      if (method === 'POST' && options.deps.config.readOnlyMembers.has(member.email))
        throw new Conflict('read_only_member', 403);
      return {
        status,
        body: { apiVersion: TEAMWORK_API_VERSION, ...(await action(member, request, params)) },
      };
    },
  };
}
export function createBotRunRoutes(
  options: ExecutionOptions,
  execution: ReturnType<typeof createBotExecution>,
): readonly BotRoute[] {
  const startBotRun = createStartBotRun(options);
  const commands = createRunCommands(options, execution);
  const bot = `bots/(${UUID_PATTERN})/runs`;
  const run = `bot-runs/(${UUID_PATTERN})`;
  const route = (
    method: BotRoute['method'],
    path: string,
    action: Parameters<typeof executionRoute>[3],
    status = 200,
  ) => executionRoute(options, method, path, action, status);
  return [
    route(
      'POST',
      bot,
      async (member, request, [id]) => {
        const input = requestBody(z.strictObject({ clientRequestId: z.uuid() }), request);
        await requireOwner(options.deps.sql, member, id);
        if (!(await options.service.getActive(member, id)))
          throw new Conflict('no_published_revision');
        await bindOwner(options, member, id);
        const trigger: BotTrigger = { kind: 'manual' };
        const startInput: StartBotRunInput = {
          teammateId: id,
          trigger,
          initiatedBy: member.sub,
          clientRequestId: input.clientRequestId,
        };
        const result = await startBotRun(startInput);
        if (result.kind === 'denied' || result.kind === 'deferred')
          throw new Conflict(
            result.code,
            result.code === 'admission_denied' || result.code === 'no_published_revision'
              ? 409
              : 403,
          );
        return { run: await runView(options, member, result.taskId) };
      },
      201,
    ),
    route('GET', bot, async (member, _request, [id]) => {
      await requireOwner(options.deps.sql, member, id);
      const rows = await options.deps.sql<
        { task_id: string }[]
      >`select task_id from tw_bot_runs where teammate_id = ${id} order by created_at desc limit 50`;
      return {
        runs: await Promise.all(
          rows.map(async (r) => {
            const view = await runView(options, member, r.task_id);
            return {
              taskId: view.taskId,
              teammateId: view.teammateId,
              revision: view.revision,
              status: view.status,
              trigger: view.trigger,
              createdAt: view.createdAt,
              finishedAt: view.finishedAt,
              cost: { completeness: view.cost.completeness },
            };
          }),
        ),
      };
    }),
    route('GET', run, async (member, _request, [id]) => ({
      run: await runView(options, member, id),
    })),
    route('POST', `${run}/approvals/(${UUID_PATTERN})`, async (member, request, [id, approval]) => {
      await commands.approve(
        member,
        id,
        approval,
        requestBody(
          z.strictObject({
            decision: z.enum(['approve', 'decline']),
            actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
          }),
          request,
        ),
      );
      return { run: await runView(options, member, id) };
    }),
    route('POST', `${run}/cancel`, async (member, request, [id]) => {
      requestBody(z.strictObject({}), request);
      await commands.cancel(member, id);
      return { run: await runView(options, member, id) };
    }),
    route(
      'POST',
      `${run}/steps/([a-z][a-z0-9_]{0,31})/retry`,
      async (member, request, [id, step]) => {
        requestBody(z.strictObject({}), request);
        await commands.retry(member, id, step);
        return { run: await runView(options, member, id) };
      },
    ),
    route(
      'POST',
      `${run}/steps/([a-z][a-z0-9_]{0,31})/resolve`,
      async (member, request, [id, step]) => {
        await commands.resolve(
          member,
          id,
          step,
          requestBody(
            z.strictObject({
              outcome: z.enum(['succeeded', 'failed']),
              note: z.string().trim().min(1).max(300),
            }),
            request,
          ),
        );
        return { run: await runView(options, member, id) };
      },
    ),
  ];
}
