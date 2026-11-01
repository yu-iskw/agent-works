// localStorage access, member-scoped and tolerant of private windows where the accessor throws.

import { clearMember, draftKey, purgeOtherMembers } from '../../shared/member-tag.js';

import { isEmptyDraft } from './store/state.js';

import type { Draft } from './store/state.js';
import type { ContextChip } from '../../shared/composer.js';
import type { MemberTag } from '../../shared/member-tag.js';

export type DraftStore = {
  readonly purgeOthers: () => number;
  readonly readDraft: (conversationId: string) => Draft | undefined;
  readonly writeDraft: (conversationId: string, draft: Draft | null) => void;
  /** Clears this member's keys and refuses further writes, so nothing re-persists while leaving. */
  readonly signOut: () => number;
};

const isDraft = (value: unknown): value is Draft =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Draft).text === 'string' &&
  ((value as Draft).clientRequestId === null ||
    typeof (value as Draft).clientRequestId === 'string');

/** Drafts saved before chips existed carry none; an upload interrupted by a reload cannot resume. */
const normalizeDraft = (draft: Draft): Draft => {
  const chips: readonly ContextChip[] = Array.isArray(draft.chips) ? draft.chips : [];
  return {
    ...draft,
    chips: chips.filter((chip) => chip.kind !== 'file' || chip.status !== 'uploading'),
    target: draft.target ?? null,
  };
};

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
  let closed = false;
  return {
    purgeOthers: () => safe((s) => purgeOtherMembers(s, tag), 0),
    readDraft: (id) =>
      safe((s) => {
        const raw = s.getItem(draftKey(tag, segment, id));
        if (raw === null) return undefined;
        const parsed: unknown = JSON.parse(raw);
        if (!isDraft(parsed)) return undefined;
        const draft = normalizeDraft(parsed);
        return isEmptyDraft(draft) ? undefined : draft;
      }, undefined),
    writeDraft: (id, draft) =>
      safe((s) => {
        if (closed) return;
        const key = draftKey(tag, segment, id);
        if (draft === null || isEmptyDraft(draft)) s.removeItem(key);
        else s.setItem(key, JSON.stringify(draft));
      }, undefined),
    signOut: () => {
      closed = true;
      return safe((s) => clearMember(s, tag), 0);
    },
  };
}

export function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
