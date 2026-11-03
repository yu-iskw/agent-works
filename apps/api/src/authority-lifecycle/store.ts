import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';

type GrantAuditEvent = 'issued' | 'issue_denied' | 'revoked' | 'revoked_by_ancestor' | 'reviewed';

export type GrantAuditEntry = {
  /** The grant acted on, or the requested id of a denied issuance. */
  readonly grantId: string;
  readonly event: GrantAuditEvent;
  readonly actor: string;
  readonly occurredAt: string;
  /** Safe codes and ids only, never a payload. */
  readonly detail: { readonly [key: string]: string | number | boolean | null };
};

type InsertOptions = {
  readonly now: string;
  /** The parent's fan-out cap: most active children a parent may hold. */
  readonly maxActiveChildren?: number;
};

export type InsertOutcome = 'inserted' | 'duplicate' | 'parent_unusable' | 'fan_out_exceeded';

type RevokeInput = {
  readonly grantId: string;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
};

/**
 * The one port both stores implement. Each method is atomic: a grant and its audit row, or a
 * revocation and every audit row it causes, commit together or not at all.
 */
export type GrantStore = {
  /** Writes the grant and its `issued` audit row. A child also checks its parent and fan-out. */
  insert(grant: StandingGrant, options: InsertOptions): Promise<InsertOutcome>;
  get(grantId: string): Promise<StandingGrant | undefined>;
  /** The grant first, then each ancestor up to the root. Empty when the grant is unknown. */
  chain(grantId: string): Promise<readonly StandingGrant[]>;
  list(filter?: { readonly sponsor?: string }): Promise<readonly StandingGrant[]>;
  /**
   * Revokes the grant and every active descendant. Returns the ids newly revoked, so a repeat
   * call returns none and writes nothing.
   */
  revokeTree(input: RevokeInput): Promise<readonly string[]>;
  appendAudit(entry: GrantAuditEntry): Promise<void>;
  readAudit(grantId: string): Promise<readonly GrantAuditEntry[]>;
};
