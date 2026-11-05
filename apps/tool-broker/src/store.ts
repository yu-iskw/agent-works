type GrantStatus = 'active' | 'revoked' | 'expired';

/** Holds the secrets for one user's connection. Never leaves the broker. */
export type StoredGrant = {
  readonly tokenRef: string;
  readonly provider: 'google';
  readonly subject: string;
  readonly scope: string;
  readonly googleSubject: string;
  readonly googleEmail: string;
  readonly status: GrantStatus;
  readonly expiresAt: string;
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
};

export interface GrantStore {
  save(grant: StoredGrant): void;
  get(tokenRef: string): StoredGrant | undefined;
  setStatus(tokenRef: string, status: GrantStatus): StoredGrant | undefined;
}

/**
 * Process-local store. Grants vanish on restart, so this is only for the first deployable slice.
 * A durable store must replace it before production use.
 */
export function createMemoryStore(): GrantStore {
  const grants = new Map<string, StoredGrant>();
  return {
    save(grant) {
      grants.set(grant.tokenRef, grant);
    },
    get(tokenRef) {
      return grants.get(tokenRef);
    },
    setStatus(tokenRef, status) {
      const grant = grants.get(tokenRef);
      if (grant === undefined) return undefined;
      const next = { ...grant, status };
      grants.set(tokenRef, next);
      return next;
    },
  };
}
