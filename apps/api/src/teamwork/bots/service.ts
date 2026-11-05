import {
  canonicalPayloadSha256,
  parseBotProposal,
  validateBotDefinition,
} from '@agent-works/domain';

import { Conflict, audit } from '../context.js';
import { segmentCapabilities } from '../installations.js';

import { previewBot } from './preview.js';
import { latestRevision, requireOwner, revisionView, withBot } from './store.js';

import type { RevisionRow } from './store.js';
import type { Deps, Member, Tx } from '../context.js';
import type { BotDefinition, BotDiagnostic, BotValidationContext } from '@agent-works/domain';

export class InvalidBotDefinition extends Conflict {
  constructor(readonly diagnostics: readonly BotDiagnostic[]) {
    super('invalid_bot_definition', 400);
  }
}
export type BotSource = {
  readonly source: RevisionRow['source'];
  readonly sourceMessageId?: string | null;
};
export type BotConfirmation = { readonly revision: number; readonly digest: string };
type ContextProvider = () => Promise<BotValidationContext>;

export function createBotService(
  deps: Deps,
  context: ContextProvider = async () => ({
    segmentCapabilities: await segmentCapabilities(deps),
    approvedAgents: { get: () => undefined },
    skills: { resolve: () => Promise.resolve({ ok: false, code: 'unknown_package' }) },
  }),
) {
  async function validated(input: unknown): Promise<BotDefinition> {
    const parsed = parseBotProposal(input);
    if (!parsed.success) throw new InvalidBotDefinition(parsed.diagnostics);
    const diagnostics = await validateBotDefinition(parsed.definition, await context());
    if (diagnostics.length > 0) throw new InvalidBotDefinition(diagnostics);
    return parsed.definition;
  }
  async function insert(
    tx: Tx,
    member: Member,
    teammateId: string,
    definition: BotDefinition,
    provenance: BotSource & { readonly revision: number },
  ) {
    const { revision, ...source } = provenance;
    const digest = canonicalPayloadSha256(definition);
    await tx`insert into tw_bots (teammate_id, owner_sub, updated_at) values (${teammateId}, ${member.sub}, ${deps.now()}) on conflict (teammate_id) do update set updated_at = excluded.updated_at`;
    const row = (
      await tx<RevisionRow[]>`
      insert into tw_bot_revisions (teammate_id, revision, definition, digest, state, source, source_message_id, created_by, created_at)
      values (${teammateId}, ${revision}, ${tx.json(definition)}, ${digest}, 'draft', ${source.source}, ${source.sourceMessageId ?? null}, ${member.sub}, ${deps.now()}) returning *
    `
    )[0];
    await audit(deps, tx, {
      ownerSub: member.sub,
      action: 'bot.draft',
      outcome: 'created',
      detail: { teammateId, revision, digest },
    });
    return revisionView(row);
  }
  function assertConfirmation(row: RevisionRow | undefined, confirmation: BotConfirmation) {
    if (
      row === undefined ||
      row.state !== 'draft' ||
      row.revision !== confirmation.revision ||
      row.digest !== confirmation.digest
    )
      throw new Conflict('stale_confirmation');
    return row;
  }
  /** Read-only members may view bots but never change a definition or activate one (T7-01). */
  function assertWritable(member: Member): void {
    if (deps.config.readOnlyMembers.has(member.email)) throw new Conflict('read_only_member', 403);
  }
  async function inBot<T>(
    member: Member,
    teammateId: string,
    action: (tx: Tx) => Promise<T>,
    outer?: Tx,
  ): Promise<T> {
    if (outer === undefined) return withBot(deps, member, teammateId, action);
    await requireOwner(outer, member, teammateId, true);
    return action(outer);
  }
  function createDraft(
    member: Member,
    teammateId: string,
    definition: unknown,
    source: BotSource,
    outer?: Tx,
  ) {
    assertWritable(member);
    return inBot(
      member,
      teammateId,
      async (tx) => {
        const latest = await latestRevision(tx, teammateId);
        if (latest?.state === 'draft') throw new Conflict('draft_exists');
        return insert(tx, member, teammateId, await validated(definition), {
          ...source,
          revision: (latest?.revision ?? 0) + 1,
        });
      },
      outer,
    );
  }
  // Existing callers use positional arguments; a caller transaction is optional.
  // eslint-disable-next-line max-params
  function reviseDraft(
    member: Member,
    teammateId: string,
    cas: { readonly baseRevision: number; readonly baseDigest: string },
    definition: unknown,
    source: BotSource = { source: 'api' },
    outer?: Tx,
  ) {
    assertWritable(member);
    return inBot(
      member,
      teammateId,
      async (tx) => {
        const latest = await latestRevision(tx, teammateId);
        if (
          latest === undefined ||
          !['draft', 'published'].includes(latest.state) ||
          latest.revision !== cas.baseRevision ||
          latest.digest !== cas.baseDigest
        )
          throw new Conflict('stale_confirmation');
        const next = await validated(definition);
        if (latest.state === 'draft')
          await tx`update tw_bot_revisions set state = 'discarded' where teammate_id = ${teammateId} and revision = ${latest.revision}`;
        return insert(tx, member, teammateId, next, {
          ...source,
          revision: latest.revision + 1,
        });
      },
      outer,
    );
  }
  function previewDraft(member: Member, teammateId: string, outer?: Tx) {
    return inBot(
      member,
      teammateId,
      async (tx) => {
        const row = await latestRevision(tx, teammateId);
        if (row?.state !== 'draft') throw new Conflict('not_found', 404);
        const preview = await previewBot(row.definition, await context());
        if (!preview.success) throw new InvalidBotDefinition(preview.diagnostics);
        return { revision: row.revision, ...preview.preview };
      },
      outer,
    );
  }
  return {
    createDraft,
    reviseDraft,
    previewDraft,
    publish: (member: Member, teammateId: string, confirmation: BotConfirmation) => {
      assertWritable(member);
      return withBot(deps, member, teammateId, async (tx) => {
        const row = assertConfirmation(await latestRevision(tx, teammateId), confirmation);
        const definition = await validated(row.definition);
        if (canonicalPayloadSha256(definition) !== confirmation.digest)
          throw new Conflict('stale_confirmation');
        await tx`update tw_bot_revisions set state = 'superseded' where teammate_id = ${teammateId} and state = 'published'`;
        const published = (
          await tx<
            RevisionRow[]
          >`update tw_bot_revisions set state = 'published', published_by = ${member.sub}, published_at = ${deps.now()} where teammate_id = ${teammateId} and revision = ${row.revision} and state = 'draft' and digest = ${confirmation.digest} returning *`
        ).at(0);
        if (published === undefined) throw new Conflict('stale_confirmation');
        // Publishing is the authenticated act that defines bot authority, so it binds the owner email
        // background runs check membership against (D37).
        await tx`update tw_bots set active_revision = ${row.revision}, owner_email = ${member.email.toLowerCase()}, updated_at = ${deps.now()} where teammate_id = ${teammateId}`;
        await audit(deps, tx, {
          ownerSub: member.sub,
          action: 'bot.publish',
          outcome: 'published',
          detail: { teammateId, revision: row.revision, digest: row.digest },
        });
        return revisionView(published);
      });
    },
    async getActive(member: Member, teammateId: string) {
      await requireOwner(deps.sql, member, teammateId);
      const row = (
        await deps.sql<
          RevisionRow[]
        >`select r.* from tw_bots b join tw_bot_revisions r on r.teammate_id = b.teammate_id and r.revision = b.active_revision where b.teammate_id = ${teammateId} and r.state = 'published'`
      ).at(0);
      return row === undefined ? undefined : revisionView(row);
    },
    async listRevisions(member: Member, teammateId: string) {
      await requireOwner(deps.sql, member, teammateId);
      return (
        await deps.sql<
          RevisionRow[]
        >`select * from tw_bot_revisions where teammate_id = ${teammateId} order by revision desc`
      ).map(revisionView);
    },
    async exportRevision(member: Member, teammateId: string, revision: number) {
      await requireOwner(deps.sql, member, teammateId);
      const row = (
        await deps.sql<
          RevisionRow[]
        >`select * from tw_bot_revisions where teammate_id = ${teammateId} and revision = ${revision}`
      ).at(0);
      if (row === undefined) throw new Conflict('not_found', 404);
      return {
        apiVersion: row.definition.apiVersion,
        definition: row.definition,
        digest: row.digest,
        provenance: {
          teammateId,
          revision,
          source: row.source,
          sourceMessageId: row.source_message_id,
          createdBy: row.created_by,
          createdAt: row.created_at.toISOString(),
          publishedBy: row.published_by,
          publishedAt: row.published_at?.toISOString() ?? null,
        },
      };
    },
    async pinForRun(teammateId: string) {
      const row = (
        await deps.sql<
          RevisionRow[]
        >`select r.* from tw_bots b join tw_teammates t on t.id = b.teammate_id join tw_bot_revisions r on r.teammate_id = b.teammate_id and r.revision = b.active_revision where b.teammate_id = ${teammateId} and not t.archived and r.state = 'published'`
      ).at(0);
      if (row === undefined) throw new Conflict('not_found', 404);
      return { revision: row.revision, digest: row.digest, definition: row.definition };
    },
  };
}
