import { createHash } from 'node:crypto';

import type { MemberTag } from '../../shared/member-tag.js';

/** Browser storage is keyed by this tag, never by the subject itself. */
export function memberTag(sub: string): MemberTag {
  return createHash('sha256').update(sub).digest('hex').slice(0, 16) as MemberTag;
}
