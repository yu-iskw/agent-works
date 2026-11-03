import type { GrantAuditEntry, GrantStore } from './store.js';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

/** In-process store for tests and local runs. Same observable rules as the Postgres store. */
export function createMemoryGrantStore(): GrantStore {
  const grants = new Map<string, StandingGrant>();
  const audit: GrantAuditEntry[] = [];

  const activeChildren = (parentId: string, now: string): number =>
    [...grants.values()].filter(
      (grant) =>
        grant.parentGrantId === parentId &&
        grant.revocation.status === 'active' &&
        Date.parse(grant.expiresAt) > Date.parse(now),
    ).length;

  const subtreeOf = (rootId: string): Set<string> => {
    const subtree = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const grant of grants.values()) {
        const inside = grant.parentGrantId !== null && subtree.has(grant.parentGrantId);
        if (inside && !subtree.has(grant.grantId)) {
          subtree.add(grant.grantId);
          grew = true;
        }
      }
    }
    return subtree;
  };

  const chain = (grantId: string): StandingGrant[] => {
    const result: StandingGrant[] = [];
    let current = grants.get(grantId);
    while (current !== undefined) {
      result.push(current);
      current = current.parentGrantId === null ? undefined : grants.get(current.parentGrantId);
    }
    return result;
  };

  return {
    insert(grant, options) {
      if (grants.has(grant.grantId)) return Promise.resolve('duplicate');
      if (grant.parentGrantId !== null) {
        const parent = grants.get(grant.parentGrantId);
        if (
          parent === undefined ||
          parent.revocation.status !== 'active' ||
          Date.parse(parent.expiresAt) <= Date.parse(options.now)
        ) {
          return Promise.resolve('parent_unusable');
        }
        if (
          options.maxActiveChildren !== undefined &&
          activeChildren(parent.grantId, options.now) >= options.maxActiveChildren
        ) {
          return Promise.resolve('fan_out_exceeded');
        }
      }
      grants.set(grant.grantId, structuredClone(grant));
      audit.push({
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
      return Promise.resolve('inserted');
    },
    get: (grantId) => Promise.resolve(structuredClone(grants.get(grantId))),
    chain: (grantId) => Promise.resolve(structuredClone(chain(grantId))),
    list: (filter) =>
      Promise.resolve(
        structuredClone(
          [...grants.values()].filter(
            (grant) => filter?.sponsor === undefined || grant.sponsor === filter.sponsor,
          ),
        ),
      ),
    revokeTree(input) {
      const target = grants.get(input.grantId);
      if (target === undefined) return Promise.resolve([]);
      const subtree = subtreeOf(input.grantId);
      const revoked: string[] = [];
      for (const id of subtree) {
        const grant = grants.get(id);
        if (grant === undefined || grant.revocation.status === 'revoked') continue;
        grants.set(id, {
          ...grant,
          revocation: { status: 'revoked', revokedAt: input.at, revokedBy: input.by },
        });
        revoked.push(id);
        audit.push({
          grantId: id,
          event: id === input.grantId ? 'revoked' : 'revoked_by_ancestor',
          actor: input.by,
          occurredAt: input.at,
          detail: { reason: input.reason, rootOfRevocation: input.grantId },
        });
      }
      return Promise.resolve(revoked);
    },
    appendAudit(entry) {
      audit.push(structuredClone(entry));
      return Promise.resolve();
    },
    readAudit: (grantId) =>
      Promise.resolve(structuredClone(audit.filter((entry) => entry.grantId === grantId))),
  };
}
