import { ACCENTS, AVATAR_IDS as DOMAIN_AVATARS } from '@agent-works/domain/teamwork';
import { describe, expect, it } from 'vitest';

import { ACCENT_IDS, AVATAR_IDS } from './contract.js';

// The browser cannot import the domain's zod module, so the contract keeps its own copies. A
// drift would make the BFF quietly blank an avatar or accent the segment accepts.
describe('identity vocabularies', () => {
  it('match the domain exactly', () => {
    expect([...AVATAR_IDS]).toEqual([...DOMAIN_AVATARS]);
    expect([...ACCENT_IDS]).toEqual([...ACCENTS]);
  });
});
