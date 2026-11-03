import { standingGrantSchema } from '@agent-works/domain/standing-grant-contract';

import type { GrantAuditEntry, GrantStore, InsertOutcome } from './store.js';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';
import type postgres from 'postgres';

type Db = postgres.Sql | postgres.TransactionSql;

type GrantRow = {
  grant_id: string;
  issuer: string;
  sponsor: string;
  grantee_bot_id: string;
  grantee_bot_version: number;
  permissions: unknown;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  parent_grant_id: string | null;
  depth: number;
  max_depth: number;
  schedule: unknown;
  limits: unknown;
  policy_revision: string;
  audit_ref: string;
};

function toGrant(row: GrantRow): StandingGrant {
  return standingGrantSchema.parse({
    grantId: row.grant_id,
    issuer: row.issuer,
    sponsor: row.sponsor,
    grantee: { botId: row.grantee_bot_id, botVersion: row.grantee_bot_version },
    permissions: row.permissions,
    issuedAt: row.issued_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revocation:
      row.revoked_at === null || row.revoked_by === null
        ? { status: 'active' }
        : { status: 'revoked', revokedAt: row.revoked_at.toISOString(), revokedBy: row.revoked_by },
    parentGrantId: row.parent_grant_id,
    depth: row.depth,
    maxDepth: row.max_depth,
    schedule: row.schedule,
    limits: row.limits,
    policyRevision: row.policy_revision,
    auditRef: row.audit_ref,
  });
}

async function writeAudit(db: Db, entry: GrantAuditEntry): Promise<void> {
  await db`
    insert into tw_standing_grant_audit (grant_id, event, actor, occurred_at, detail)
    values (${entry.grantId}, ${entry.event}, ${entry.actor}, ${entry.occurredAt}::timestamptz,
      ${db.json({ ...entry.detail })})
  `;
}

/**
 * Postgres store over `0024_standing_grants.sql`. A child insert locks its parent row, so
 * concurrent sibling issuance cannot pass the fan-out cap together and a revocation that commits
 * first is seen by the insert. A descendant inserted below a deeper node while an ancestor is
 * being revoked can outlive the sweep; the resolver walks the chain, so it still denies.
 */
export function createPostgresGrantStore(sql: postgres.Sql): GrantStore {
  return {
    insert(grant, options) {
      return sql.begin(async (tx): Promise<InsertOutcome> => {
        if (grant.parentGrantId !== null) {
          const parents = await tx<{ revoked_at: Date | null; expires_at: Date }[]>`
            select revoked_at, expires_at from tw_standing_grants
            where grant_id = ${grant.parentGrantId} for update
          `;
          const parent = parents.at(0);
          if (
            parent === undefined ||
            parent.revoked_at !== null ||
            parent.expires_at.getTime() <= Date.parse(options.now)
          ) {
            return 'parent_unusable';
          }
          if (options.maxActiveChildren !== undefined) {
            const counted = await tx<{ count: number }[]>`
              select count(*)::int as count from tw_standing_grants
              where parent_grant_id = ${grant.parentGrantId} and revoked_at is null
                and expires_at > ${options.now}::timestamptz
            `;
            if ((counted.at(0)?.count ?? 0) >= options.maxActiveChildren) {
              return 'fan_out_exceeded';
            }
          }
        }
        const inserted = await tx`
          insert into tw_standing_grants (
            grant_id, issuer, sponsor, grantee_bot_id, grantee_bot_version, permissions,
            issued_at, expires_at, parent_grant_id, depth, max_depth, schedule, limits,
            policy_revision, audit_ref
          ) values (
            ${grant.grantId}, ${grant.issuer}, ${grant.sponsor}, ${grant.grantee.botId},
            ${grant.grantee.botVersion}, ${tx.json([...grant.permissions])},
            ${grant.issuedAt}::timestamptz, ${grant.expiresAt}::timestamptz,
            ${grant.parentGrantId}, ${grant.depth}, ${grant.maxDepth},
            ${tx.json({ ...grant.schedule })}, ${tx.json({ ...grant.limits })},
            ${grant.policyRevision}, ${grant.auditRef}
          ) on conflict (grant_id) do nothing returning grant_id
        `;
        if (inserted.length === 0) return 'duplicate';
        await writeAudit(tx, {
          grantId: grant.grantId,
          event: 'issued',
          actor: grant.issuer,
          occurredAt: options.now,
          detail: {
            sponsor: grant.sponsor,
            parentGrantId: grant.parentGrantId,
            depth: grant.depth,
            auditRef: grant.auditRef,
          },
        });
        return 'inserted';
      });
    },
    async get(grantId) {
      const rows = await sql<GrantRow[]>`
        select * from tw_standing_grants where grant_id = ${grantId}
      `;
      const row = rows.at(0);
      return row === undefined ? undefined : toGrant(row);
    },
    async chain(grantId) {
      const rows = await sql<GrantRow[]>`
        with recursive up as (
          select g.*, 0 as hop from tw_standing_grants g where g.grant_id = ${grantId}
          union all
          select g.*, up.hop + 1 from tw_standing_grants g
          join up on g.grant_id = up.parent_grant_id
        )
        select * from up order by hop
      `;
      return rows.map(toGrant);
    },
    async list(filter) {
      const sponsor = filter?.sponsor ?? null;
      const rows = await sql<GrantRow[]>`
        select * from tw_standing_grants
        where (${sponsor}::text is null or sponsor = ${sponsor}) order by issued_at, grant_id
      `;
      return rows.map(toGrant);
    },
    revokeTree(input) {
      return sql.begin(async (tx) => {
        const locked = await tx`
          select 1 from tw_standing_grants where grant_id = ${input.grantId} for update
        `;
        if (locked.length === 0) return [];
        const revoked = await tx<{ grant_id: string }[]>`
          with recursive tree as (
            select grant_id from tw_standing_grants where grant_id = ${input.grantId}
            union all
            select g.grant_id from tw_standing_grants g
            join tree on g.parent_grant_id = tree.grant_id
          )
          update tw_standing_grants
          set revoked_at = ${input.at}::timestamptz, revoked_by = ${input.by}
          where grant_id in (select grant_id from tree) and revoked_at is null
          returning grant_id
        `;
        for (const { grant_id: id } of revoked) {
          await writeAudit(tx, {
            grantId: id,
            event: id === input.grantId ? 'revoked' : 'revoked_by_ancestor',
            actor: input.by,
            occurredAt: input.at,
            detail: { reason: input.reason, rootOfRevocation: input.grantId },
          });
        }
        return revoked.map((row) => row.grant_id);
      });
    },
    appendAudit: (entry) => writeAudit(sql, entry),
    async readAudit(grantId) {
      const rows = await sql<
        {
          grant_id: string;
          event: GrantAuditEntry['event'];
          actor: string;
          occurred_at: Date;
          detail: GrantAuditEntry['detail'];
        }[]
      >`select grant_id, event, actor, occurred_at, detail from tw_standing_grant_audit
        where grant_id = ${grantId} order by seq`;
      return rows.map((row) => ({
        grantId: row.grant_id,
        event: row.event,
        actor: row.actor,
        occurredAt: row.occurred_at.toISOString(),
        detail: row.detail,
      }));
    },
  };
}
