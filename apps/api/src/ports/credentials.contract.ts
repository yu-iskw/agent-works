import { oauthApiSchema } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import type { CredentialsPort } from './credentials.js';
import type { OAuthConnection } from '@agent-works/domain';

const alice: OAuthConnection = {
  provider: 'fake',
  subject: 'alice',
  scope: 'ticket.create',
  status: 'active',
  expiresAt: '2026-12-31T00:00:00.000Z',
  tokenRef: 'token-1',
};

export function credentialsPortContract(create: () => CredentialsPort): void {
  describe('CredentialsPort', () => {
    it('stores a connection without a raw token field', async () => {
      const port = create();
      const saved = await port.save(alice);
      expect(oauthApiSchema.parse({ kind: 'connection', ...saved })).toEqual({
        kind: 'connection',
        ...alice,
      });
      expect(await port.read('alice', 'fake')).toEqual(alice);
      expect(await port.read('bob', 'fake')).toBeUndefined();
      const revoked: OAuthConnection = { ...alice, status: 'revoked', tokenRef: 'token-1' };
      expect(await port.save(revoked)).toEqual(revoked);
      expect(await port.read('alice', 'fake')).toEqual(revoked);
    });
  });
}
