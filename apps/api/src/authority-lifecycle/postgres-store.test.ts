import { describe, expect, it } from 'vitest';

import { applyStandingGrantMigration } from './migration.js';
import { createPostgresGrantStore } from './postgres-store.js';
import { resolveStandingAuthority } from './resolver.js';
import {
  TICKET_ACTION,
  childRequest,
  clock,
  coordinator,
  lifecycleOver,
  owner,
  rootRequest,
  useStores,
} from './test-kit.js';

const stores = useStores();

async function seeded() {
  const store = createPostgresGrantStore(stores.sql());
  const time = clock();
  const lifecycle = lifecycleOver(store, time);
  const root = await lifecycle.issueRoot(owner, rootRequest());
  if (!root.ok) throw new Error('setup');
  return { store, time, lifecycle, rootId: root.grant.grantId };
}

describe('0024_standing_grants on real Postgres', () => {
  it('applies once and is re-runnable', async () => {
    await applyStandingGrantMigration(stores.sql());
    await applyStandingGrantMigration(stores.sql());
    const rows = await stores.sql()`
      select count(*)::int as count from schema_migrations where name = '0024_standing_grants.sql'
    `;
    expect(rows[0].count).toBe(1);
  });

  it('round-trips a grant unchanged', async () => {
    const { store, rootId } = await seeded();
    const grant = await store.get(rootId);
    expect(grant).toMatchObject({
      grantId: rootId,
      sponsor: 'alice',
      permissions: rootRequest().permissions,
      limits: rootRequest().limits,
    });
    expect(await store.chain(rootId)).toEqual([grant]);
  });

  it('refuses to edit an issued grant, delete one, or touch the audit trail', async () => {
    const { rootId } = await seeded();
    const sql = stores.sql();
    await expect(
      sql`update tw_standing_grants set expires_at = expires_at + interval '1 day' where grant_id = ${rootId}`,
    ).rejects.toThrow('immutable apart from revocation');
    await expect(sql`delete from tw_standing_grants where grant_id = ${rootId}`).rejects.toThrow(
      'never deleted',
    );
    await expect(sql`update tw_standing_grant_audit set actor = 'x'`).rejects.toThrow(
      'append-only',
    );
    await expect(sql`delete from tw_standing_grant_audit`).rejects.toThrow('append-only');
  });

  it('keeps a revoked grant revoked', async () => {
    const { rootId } = await seeded();
    const sql = stores.sql();
    await sql`update tw_standing_grants set revoked_at = now(), revoked_by = 'a' where grant_id = ${rootId}`;
    await expect(
      sql`update tw_standing_grants set revoked_at = null, revoked_by = null where grant_id = ${rootId}`,
    ).rejects.toThrow('final');
  });

  it('rejects a half-recorded revocation and a child with a missing parent at the schema', async () => {
    const { rootId } = await seeded();
    const sql = stores.sql();
    await expect(
      sql`update tw_standing_grants set revoked_at = now() where grant_id = ${rootId}`,
    ).rejects.toThrow();
    await expect(
      sql`insert into tw_standing_grants (grant_id, issuer, sponsor, grantee_bot_id, grantee_bot_version,
        permissions, issued_at, expires_at, parent_grant_id, depth, max_depth, schedule, limits,
        policy_revision, audit_ref)
        values ('orphan', 'i', 's', 'b', 1, '[]', now(), now() + interval '1 day', 'nope', 1, 2,
        '{}', '{}', 'p', 'a')`,
    ).rejects.toThrow();
  });

  it('admits exactly the fan-out cap when sibling issuance races', async () => {
    const { lifecycle, rootId, store } = await seeded();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => lifecycle.issueChild(coordinator, rootId, childRequest())),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.code === 'FAN_OUT_EXCEEDED')).toHaveLength(7);
    expect(await store.list()).toHaveLength(4);
  });

  it('never leaves an active child under a revoked parent when issue races revoke', async () => {
    for (let round = 0; round < 15; round += 1) {
      const { lifecycle, rootId, store } = await seeded();
      await Promise.all([
        lifecycle.issueChild(coordinator, rootId, childRequest()),
        lifecycle.issueChild(coordinator, rootId, childRequest()),
        lifecycle.revoke(owner, rootId, 'race'),
      ]);
      const grants = await store.list();
      expect(grants.every((g) => g.revocation.status === 'revoked')).toBe(true);
      await stores.sql()`truncate table tw_standing_grants, tw_standing_grant_audit`;
    }
  });

  it('serialises concurrent revocations: each grant is revoked and audited once', async () => {
    const { lifecycle, rootId, store } = await seeded();
    const child = await lifecycle.issueChild(coordinator, rootId, childRequest());
    if (!child.ok) throw new Error('setup');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => lifecycle.revoke(owner, rootId, 'dup')),
    );
    expect(results.flatMap((r) => (r.ok ? r.revoked : []))).toHaveLength(2);
    expect((await store.readAudit(child.grant.grantId)).map((e) => e.event)).toEqual([
      'issued',
      'revoked_by_ancestor',
    ]);
  });

  it('denies a descendant left active under a revoked ancestor, because the chain is walked', async () => {
    const { lifecycle, rootId, store, time } = await seeded();
    const child = await lifecycle.issueChild(
      coordinator,
      rootId,
      childRequest({ permissions: [{ action: TICKET_ACTION, resource: 'PROJ' }] }),
    );
    if (!child.ok) throw new Error('setup');
    await stores.sql()`
      update tw_standing_grants set revoked_at = now(), revoked_by = 'sweep-missed-child'
      where grant_id = ${rootId}
    `;
    expect((await store.get(child.grant.grantId))?.revocation.status).toBe('active');
    const answer = await resolveStandingAuthority(
      { store, activation: { enabled: true }, now: () => time.now },
      { grantId: child.grant.grantId, action: TICKET_ACTION, resource: 'PROJ' },
    );
    expect(answer).toEqual({ kind: 'denied', reason: 'ancestor_unusable' });
  });

  it('writes the denied-issuance audit row even though no grant exists', async () => {
    const store = createPostgresGrantStore(stores.sql());
    const lifecycle = lifecycleOver(store, clock(), { enabled: false }, () => 'grant-denied');
    await lifecycle.issueRoot(owner, rootRequest());
    expect(await store.readAudit('grant-denied')).toMatchObject([
      { event: 'issue_denied', detail: { code: 'ACTIVATION_OFF' } },
    ]);
    expect(await store.list()).toEqual([]);
  });
});
