// localStorage access, member-scoped and tolerant of private windows where the accessor throws.

import { clearDrafts, draftKey, purgeOtherMembers } from '../../shared/member-tag.js';

import type { Draft } from './store/state.js';
import type { MemberTag } from '../../shared/member-tag.js';

export type DraftStore = {
  readonly purgeOthers: () => number;
  readonly readDraft: (conversationId: string) => Draft | undefined;
  readonly writeDraft: (conversationId: string, draft: Draft | null) => void;
  readonly clearMine: () => number;
};

const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Draft).text === 'string' &&
  ((value as Draft).clientRequestId === null ||
    typeof (value as Draft).clientRequestId === 'string');

export function createDraftStore(
  tag: MemberTag,
  segment: string,
  storage: () => Storage | undefined,
): DraftStore {
  const safe = <T>(run: (s: Storage) => T, fallback: T): T => {
    try {
      const s = storage();
      return s === undefined ? fallback : run(s);
    } catch {
      return fallback;
    }
  };
  return {
    purgeOthers: () => safe((s) => purgeOtherMembers(s, tag), 0),
    readDraft: (id) =>
      safe((s) => {
        const raw = s.getItem(draftKey(tag, segment, id));
        if (raw === null) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isDraft(parsed) && parsed.text !== '' ? parsed : undefined;
      }, undefined),
    writeDraft: (id, draft) =>
      safe((s) => {
        const key = draftKey(tag, segment, id);
        if (draft === null || draft.text === '') s.removeItem(key);
        else s.setItem(key, JSON.stringify(draft));
      }, undefined),
    clearMine: () => safe((s) => clearDrafts(s, tag, segment), 0),
  };
}

export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
