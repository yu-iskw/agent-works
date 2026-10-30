// Browser storage is keyed by a member tag, the first 16 hex characters of sha256(sub), never the
// subject itself. The server computes the tag (see app/workspace/member-tag.ts); this module is the
// key grammar and the purge rules the client applies on boot and on sign-out.

export type MemberTag = string & { readonly __brand: 'MemberTag' };

const TAG = /^[0-9a-f]{16}$/;
const PREFIX = 'aw:';

export function isMemberTag(value: string): value is MemberTag {
  return TAG.test(value);
}

export const storageKey = (tag: MemberTag, segment: string, ...parts: readonly string[]): string =>
  [PREFIX.slice(0, -1), tag, segment, ...parts].join(':');

export const draftKey = (tag: MemberTag, segment: string, conversationId: string): string =>
  storageKey(tag, segment, 'draft', conversationId);

/** The subset of `Storage` these helpers touch, so tests can pass a plain map. */
export type KeyStore = {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
};

function keysOf(store: KeyStore): readonly string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key !== null) keys.push(key);
  }
  return keys;
}

function removeWhere(store: KeyStore, keep: (key: string) => boolean): number {
  const doomed = keysOf(store).filter((key) => key.startsWith(PREFIX) && !keep(key));
  for (const key of doomed) store.removeItem(key);
  return doomed.length;
}

/** Removes every workspace key that belongs to another member. Returns how many were removed. */
export function purgeOtherMembers(store: KeyStore, keep: MemberTag): number {
  return removeWhere(store, (key) => key.startsWith(`${PREFIX}${keep}:`));
}

/** Removes this member's drafts in one segment (sign-out keeps preferences, which live server-side). */
export function clearDrafts(store: KeyStore, tag: MemberTag, segment: string): number {
  const prefix = storageKey(tag, segment, 'draft', '');
  return removeWhere(store, (key) => !key.startsWith(prefix));
}
