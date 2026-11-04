import { botDefinitionSchema } from '@agent-works/domain';

import { Conflict } from '../context.js';

import type { Deps, Member, Tx } from '../context.js';
import type { BotDefinition } from '@agent-works/domain';
import type postgres from 'postgres';

type Db = postgres.Sql | Tx;
export type RevisionRow = {
  teammate_id: string;
  revision: number;
  definition: BotDefinition;
  digest: string;
  state: 'draft' | 'published' | 'superseded' | 'discarded';
  source: 'conversation' | 'import' | 'api';
  source_message_id: string | null;
  created_by: string;
  created_at: Date;
  published_by: string | null;
  published_at: Date | null;
};

export async function requireOwner(
  db: Db,
  member: Member,
  teammateId: string,
  lock = false,
): Promise<void> {
  const rows = await db`
    select id from tw_teammates where id = ${teammateId} and owner_sub = ${member.sub} and not archived
    ${lock ? db`for update` : db``}
  `;
  if (rows.length === 0) throw new Conflict('not_found', 404);
}

export async function withBot<T>(
  deps: Deps,
  member: Member,
  teammateId: string,
  action: (tx: Tx) => Promise<T>,
): Promise<T> {
  let outcome: T | undefined;
  await deps.sql.begin(async (tx) => {
    await requireOwner(tx, member, teammateId, true);
    outcome = await action(tx);
  });
  if (outcome === undefined) throw new Error('bot transaction returned no outcome');
  return outcome;
}

export async function latestRevision(db: Db, teammateId: string): Promise<RevisionRow | undefined> {
  return (
    await db<
      RevisionRow[]
    >`select * from tw_bot_revisions where teammate_id = ${teammateId} order by revision desc limit 1`
  ).at(0);
}

export function revisionView(row: RevisionRow) {
  return {
    teammateId: row.teammate_id,
    revision: row.revision,
    definition: botDefinitionSchema.parse(row.definition),
    digest: row.digest,
    state: row.state,
    source: row.source,
    sourceMessageId: row.source_message_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    publishedBy: row.published_by,
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}
