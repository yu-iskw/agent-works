import { KeyUnavailable } from '../ports/governance-key-provider.js';

import type { KeyProvider } from '../ports/governance-key-provider.js';

/** Typed, explicit failure stub. No managed calls or fake-success fallback. */
export function createCloudKmsStub(enabled: boolean): KeyProvider {
  if (!enabled) throw new Error('Cloud KMS feature disabled');
  return {
    wrap: () => Promise.reject(new KeyUnavailable()),
    unwrap: () => Promise.reject(new KeyUnavailable()),
  };
}
