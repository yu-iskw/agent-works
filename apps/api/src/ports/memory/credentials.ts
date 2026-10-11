import { oauthConnectionSchema } from '@agent-works/domain';

import type { CredentialsPort } from '../credentials.js';
import type { OAuthConnection } from '@agent-works/domain';

export function createMemoryCredentialsPort(): CredentialsPort {
  const records = new Map<string, OAuthConnection>();
  return {
    save(connection) {
      const parsed = oauthConnectionSchema.parse(connection);
      records.set(connectionKey(parsed.subject, parsed.provider), parsed);
      return Promise.resolve(parsed);
    },
    read(subject, provider) {
      return Promise.resolve(records.get(connectionKey(subject, provider)));
    },
  };
}

function connectionKey(subject: string, provider: string): string {
  return `${subject}\0${provider}`;
}
