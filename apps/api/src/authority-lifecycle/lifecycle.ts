import {
  chainUsable,
  deriveChildGrant,
  standingGrantSchema,
} from '@agent-works/domain/standing-grant-contract';

import type { GrantAuditEntry, GrantStore, InsertOutcome } from './store.js';
import type {
  ChildDenial,
  ChildGrantRequest,
  StandingGrant,
} from '@agent-works/domain/standing-grant-contract';

/**
 * O04 gate. Live use needs the operator's O04 approval, so the default is OFF. It is enabled only
 * when the switch is `on` and an approval reference is recorded. Revocation and review stay
 * available while it is off, because they only narrow authority.
 */
export type GrantActivation = { readonly enabled: boolean; readonly o04ApprovalRef?: string };

/** Reads `AW_STANDING_GRANTS` and `AW_STANDING_GRANTS_O04_REF`. */
export function readGrantActivation(
  env: {
    readonly AW_STANDING_GRANTS?: string | undefined;
    readonly AW_STANDING_GRANTS_O04_REF?: string | undefined;
  } = process.env,
): GrantActivation {
  const ref = env.AW_STANDING_GRANTS_O04_REF?.trim() ?? '';
  if (env.AW_STANDING_GRANTS !== 'on' || ref === '') return { enabled: false };
  return { enabled: true, o04ApprovalRef: ref };
}

/**
 * Who is asking, as established by the server (session, directory, or the running bot's own
 * identity). Never built from model output or request fields.
 */
export type GrantActor =
  | { readonly kind: 'human'; readonly sub: string; readonly role: 'owner' | 'admin' | 'member' }
  | { readonly kind: 'bot'; readonly botId: string; readonly botVersion: number };

export type RootGrantRequest = Pick<
  StandingGrant,
  'sponsor' | 'grantee' | 'permissions' | 'expiresAt' | 'maxDepth' | 'schedule' | 'limits'
>;
export type ChildRequest = Omit<ChildGrantRequest, 'grantId' | 'auditRef' | 'issuedAt'>;

export type IssueDenial =
  | 'ACTIVATION_OFF'
  | 'NOT_AUTHORIZED'
  | 'INVALID_REQUEST'
  | 'LIFETIME_EXCEEDED'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_UNUSABLE'
  | 'NOT_PARENT_GRANTEE'
  | 'WIDENED'
  | 'FAN_OUT_EXCEEDED'
  | 'DUPLICATE';

export type IssueResult =
  | { readonly ok: true; readonly grant: StandingGrant }
  | { readonly ok: false; readonly code: IssueDenial; readonly reasons?: readonly ChildDenial[] };

type RevokeDenial = 'NOT_AUTHORIZED' | 'NOT_FOUND';
export type RevokeResult =
  | { readonly ok: true; readonly revoked: readonly string[] }
  | { readonly ok: false; readonly code: RevokeDenial };

type ReviewStatus = 'active' | 'expired' | 'revoked' | 'ancestor_unusable';
export type ReviewRow = {
  readonly grant: StandingGrant;
  readonly status: ReviewStatus;
  readonly secondsToExpiry: number;
};

export type ReviewDecision = {
  readonly decision: 'keep' | 'revoke';
  readonly note: string;
};

export type GrantLifecycleDeps = {
  readonly store: GrantStore;
  readonly activation: GrantActivation;
  readonly now: () => Date;
  readonly newId: () => string;
  /** The policy revision the server stamps on a new root grant. */
  readonly policyRevision: string;
  /** Longest a root grant may live. */
  readonly maxRootLifetimeSeconds?: number;
};

const DEFAULT_MAX_ROOT_LIFETIME_SECONDS = 90 * 24 * 3600;

const actorLabel = (actor: GrantActor): string =>
  actor.kind === 'human' ? actor.sub : `bot:${actor.botId}@${actor.botVersion}`;

const isGrantAdmin = (actor: GrantActor): boolean =>
  actor.kind === 'human' && (actor.role === 'owner' || actor.role === 'admin');

export function createGrantLifecycle(deps: GrantLifecycleDeps) {
  const { store } = deps;
  const stamp = (): string => deps.now().toISOString();

  async function deny(
    actor: GrantActor,
    grantId: string,
    code: IssueDenial,
    reasons?: readonly ChildDenial[],
  ): Promise<IssueResult> {
    const detail: GrantAuditEntry['detail'] = { code, reasons: reasons?.join(',') ?? null };
    await store.appendAudit({
      grantId,
      event: 'issue_denied',
      actor: actorLabel(actor),
      occurredAt: stamp(),
      detail,
    });
    return reasons === undefined ? { ok: false, code } : { ok: false, code, reasons };
  }

  async function persist(
    actor: GrantActor,
    candidate: unknown,
    maxActiveChildren?: number,
  ): Promise<IssueResult> {
    const parsed = standingGrantSchema.safeParse(candidate);
    if (!parsed.success) return deny(actor, grantIdOf(candidate), 'INVALID_REQUEST');
    const grant = parsed.data;
    const outcome = await store.insert(grant, {
      now: stamp(),
      ...(maxActiveChildren === undefined ? {} : { maxActiveChildren }),
    });
    if (outcome === 'inserted') return { ok: true, grant };
    return deny(actor, grant.grantId, denialFor(outcome));
  }

  /**
   * Revokes the grant and every descendant. Allowed for an owner or admin, or the sponsor of the
   * chain. Idempotent. Works while activation is off.
   */
  async function revoke(actor: GrantActor, grantId: string, reason: string): Promise<RevokeResult> {
    const grant = await store.get(grantId);
    if (grant === undefined) return { ok: false, code: 'NOT_FOUND' };
    const sponsorSelf = actor.kind === 'human' && actor.sub === grant.sponsor;
    if (!isGrantAdmin(actor) && !sponsorSelf) return { ok: false, code: 'NOT_AUTHORIZED' };
    const revoked = await store.revokeTree({
      grantId,
      by: actorLabel(actor),
      at: stamp(),
      reason,
    });
    return { ok: true, revoked };
  }

  return {
    /** A root grant. Only a human owner or admin may issue it; a bot or model output never can. */
    async issueRoot(actor: GrantActor, request: RootGrantRequest): Promise<IssueResult> {
      const grantId = deps.newId();
      if (!deps.activation.enabled) return deny(actor, grantId, 'ACTIVATION_OFF');
      if (!isGrantAdmin(actor) || actor.kind !== 'human') {
        return deny(actor, grantId, 'NOT_AUTHORIZED');
      }
      const now = deps.now();
      const ceiling = deps.maxRootLifetimeSeconds ?? DEFAULT_MAX_ROOT_LIFETIME_SECONDS;
      if (Date.parse(request.expiresAt) - now.getTime() > ceiling * 1000) {
        return deny(actor, grantId, 'LIFETIME_EXCEEDED');
      }
      if (request.sponsor.startsWith('bot:')) return deny(actor, grantId, 'INVALID_REQUEST');
      return persist(actor, {
        grantId,
        issuer: actor.sub,
        sponsor: request.sponsor,
        grantee: request.grantee,
        permissions: request.permissions,
        issuedAt: now.toISOString(),
        expiresAt: request.expiresAt,
        revocation: { status: 'active' },
        parentGrantId: null,
        depth: 0,
        maxDepth: request.maxDepth,
        schedule: request.schedule,
        limits: request.limits,
        policyRevision: deps.policyRevision,
        auditRef: `audit:${grantId}:issue`,
      });
    },

    /**
     * A child grant, narrower than its parent on every axis. The caller must be the parent's
     * grantee, and the whole chain must be usable now.
     */
    async issueChild(
      actor: GrantActor,
      parentGrantId: string,
      request: ChildRequest,
    ): Promise<IssueResult> {
      const grantId = deps.newId();
      if (!deps.activation.enabled) return deny(actor, grantId, 'ACTIVATION_OFF');
      const chain = await store.chain(parentGrantId);
      const parent = chain.at(0);
      if (parent === undefined) return deny(actor, grantId, 'PARENT_NOT_FOUND');
      if (
        actor.kind !== 'bot' ||
        actor.botId !== parent.grantee.botId ||
        actor.botVersion !== parent.grantee.botVersion
      ) {
        return deny(actor, grantId, 'NOT_PARENT_GRANTEE');
      }
      const now = stamp();
      if (!chainUsable(chain, now)) return deny(actor, grantId, 'PARENT_UNUSABLE');
      let derived: ReturnType<typeof deriveChildGrant>;
      try {
        derived = deriveChildGrant(
          parent,
          { ...request, grantId, issuedAt: now, auditRef: `audit:${grantId}:issue` },
          now,
        );
      } catch {
        return deny(actor, grantId, 'INVALID_REQUEST');
      }
      if (!derived.ok) {
        return deny(
          actor,
          grantId,
          derived.reasons.includes('parent_unusable') ? 'PARENT_UNUSABLE' : 'WIDENED',
          derived.reasons,
        );
      }
      return persist(actor, derived.grant, parent.limits.maxFanOut);
    },

    revoke,

    /** Revokes every root grant a sponsor holds, so their queued and later work is denied. */
    async revokeSponsor(actor: GrantActor, sponsor: string, reason: string): Promise<RevokeResult> {
      const roots = (await store.list({ sponsor })).filter((g) => g.parentGrantId === null);
      const revoked: string[] = [];
      for (const root of roots) {
        const result = await revoke(actor, root.grantId, reason);
        if (!result.ok) return result;
        revoked.push(...result.revoked);
      }
      return { ok: true, revoked };
    },

    /** Every grant with its effective status, soonest expiry first among the live ones. */
    async listForReview(filter?: { readonly sponsor?: string }): Promise<readonly ReviewRow[]> {
      const grants = await store.list(filter);
      const byId = new Map(grants.map((grant) => [grant.grantId, grant]));
      const now = deps.now();
      const rows = grants.map((grant): ReviewRow => {
        const own = chainUsable([grant], now.toISOString());
        let status: ReviewStatus = 'active';
        if (grant.revocation.status === 'revoked') status = 'revoked';
        else if (Date.parse(grant.expiresAt) <= now.getTime()) status = 'expired';
        else if (!own || !ancestorsUsable(grant, byId, now.toISOString())) {
          status = 'ancestor_unusable';
        }
        return {
          grant,
          status,
          secondsToExpiry: Math.round((Date.parse(grant.expiresAt) - now.getTime()) / 1000),
        };
      });
      return rows.sort((a, b) => a.secondsToExpiry - b.secondsToExpiry);
    },

    /** A recorded human review. `revoke` also revokes the subtree. Owner or admin only. */
    async review(
      actor: GrantActor,
      grantId: string,
      outcome: ReviewDecision,
    ): Promise<RevokeResult> {
      if (!isGrantAdmin(actor)) return { ok: false, code: 'NOT_AUTHORIZED' };
      const grant = await store.get(grantId);
      if (grant === undefined) return { ok: false, code: 'NOT_FOUND' };
      await store.appendAudit({
        grantId,
        event: 'reviewed',
        actor: actorLabel(actor),
        occurredAt: stamp(),
        detail: { decision: outcome.decision, note: outcome.note.slice(0, 500) },
      });
      if (outcome.decision === 'keep') return { ok: true, revoked: [] };
      return revoke(actor, grantId, `review: ${outcome.note.slice(0, 200)}`);
    },

    audit: (grantId: string) => store.readAudit(grantId),
  };
}

function denialFor(outcome: Exclude<InsertOutcome, 'inserted'>): IssueDenial {
  if (outcome === 'duplicate') return 'DUPLICATE';
  return outcome === 'parent_unusable' ? 'PARENT_UNUSABLE' : 'FAN_OUT_EXCEEDED';
}

function grantIdOf(candidate: unknown): string {
  if (typeof candidate === 'object' && candidate !== null && 'grantId' in candidate) {
    return typeof candidate.grantId === 'string' ? candidate.grantId : 'unknown';
  }
  return 'unknown';
}

function ancestorsUsable(
  grant: StandingGrant,
  byId: ReadonlyMap<string, StandingGrant>,
  now: string,
): boolean {
  let parentId = grant.parentGrantId;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent === undefined || !chainUsable([parent], now)) return false;
    parentId = parent.parentGrantId;
  }
  return true;
}
