import type { ConsentRegistry } from './authority.js';
export type ConsentGrant = { ref: string; subject: string; digest: string; expiresAt: string };
/** Only trusted operator configuration calls grant/revoke. Events never reach this registry. */
export function createLocalConsentRegistry(
  grants: readonly ConsentGrant[] = [],
): ConsentRegistry & { grant(value: ConsentGrant): void; revoke(ref: string): void } {
  const values = new Map(grants.map((v) => [v.ref, structuredClone(v)]));
  return {
    grant(value) {
      values.set(value.ref, structuredClone(value));
    },
    revoke(ref) {
      values.delete(ref);
    },
    valid(ref, subject, digest, at) {
      const grant = values.get(ref);
      return Promise.resolve(
        grant !== undefined &&
          grant.subject === subject &&
          grant.digest === digest &&
          Date.parse(grant.expiresAt) > at.getTime(),
      );
    },
  };
}
