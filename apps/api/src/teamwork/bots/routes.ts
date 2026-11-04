import { sha256DigestSchema } from '@agent-works/domain';
import { TEAMWORK_API_VERSION, UUID_PATTERN } from '@agent-works/domain/teamwork';
import * as z from 'zod';

import { Conflict } from '../context.js';

import { createBotService, InvalidBotDefinition } from './service.js';

import type { Deps, Member, Reply, Request } from '../context.js';

export type BotRoute = {
  readonly method: 'GET' | 'POST';
  readonly path: RegExp;
  readonly handle: (
    context: { deps: Deps; member: Member; request: Request },
    params: readonly string[],
  ) => Promise<Reply>;
};
const confirmation = z.strictObject({
  revision: z.number().int().positive(),
  digest: sha256DigestSchema,
});
const draft = z.strictObject({
  definition: z.unknown(),
  source: z.enum(['conversation', 'import', 'api']),
  sourceMessageId: z.uuid().nullable().optional(),
});
const revise = z.strictObject({
  baseRevision: z.number().int().positive(),
  baseDigest: sha256DigestSchema,
  definition: z.unknown(),
});
function body<T>(schema: z.ZodType<T>, request: Request): T {
  try {
    return schema.parse(JSON.parse(request.body.toString('utf8')) as unknown);
  } catch {
    throw new Conflict('invalid_request', 400);
  }
}
export function createBotRoutes(deps: Deps, service = createBotService(deps)): readonly BotRoute[] {
  const route = (
    method: BotRoute['method'],
    suffix: string,
    action: (member: Member, request: Request, params: readonly string[]) => Promise<object>,
    status = 200,
  ): BotRoute => ({
    method,
    // eslint-disable-next-line security/detect-non-literal-regexp -- suffixes are fixed route-table entries
    path: new RegExp(`^/v1/teamwork/bots/(${UUID_PATTERN})${suffix}$`),
    async handle({ member, request }, params) {
      try {
        return {
          status,
          body: {
            apiVersion: TEAMWORK_API_VERSION,
            ...(await action(member, request, params)),
          },
        };
      } catch (error) {
        if (error instanceof InvalidBotDefinition)
          return {
            status: error.status,
            body: { error: error.code, diagnostics: error.diagnostics },
          };
        throw error;
      }
    },
  });
  return [
    route(
      'POST',
      '/drafts',
      async (member, request, [id]) => {
        const input = body(draft, request);
        return {
          revision: await service.createDraft(member, id, input.definition, {
            source: input.source,
            sourceMessageId: input.sourceMessageId,
          }),
        };
      },
      201,
    ),
    route(
      'POST',
      '/drafts/revise',
      async (member, request, [id]) => {
        const input = body(revise, request);
        return { revision: await service.reviseDraft(member, id, input, input.definition) };
      },
      201,
    ),
    route('GET', '/preview', async (member, _request, [id]) => ({
      preview: await service.previewDraft(member, id),
    })),
    route('POST', '/publish', async (member, request, [id]) => ({
      revision: await service.publish(member, id, body(confirmation, request)),
    })),
    route('GET', '/active', async (member, _request, [id]) => {
      const revision = await service.getActive(member, id);
      if (revision === undefined) throw new Conflict('not_found', 404);
      return { revision };
    }),
    route('GET', '/revisions', async (member, _request, [id]) => ({
      revisions: await service.listRevisions(member, id),
    })),
    route(
      'GET',
      '/revisions/([1-9][0-9]{0,8})/export',
      async (member, _request, [id, revision]) => ({
        export: await service.exportRevision(member, id, Number(revision)),
      }),
    ),
  ];
}
