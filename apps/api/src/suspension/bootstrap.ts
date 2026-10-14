import { randomUUID } from 'node:crypto';

import { capabilityKey } from '@agent-works/domain';

import { SuspensionConflict } from '../ports/suspension-ledger.js';

import type { SuspensionLedger } from '../ports/suspension-ledger.js';
import type { CapabilityVersion } from '@agent-works/domain';

/** Release bootstrap registers bundled, reviewed versions once; never restores a revoked version. */
export async function publishBundledCapabilities(
  ledger: SuspensionLedger,
  baseline: readonly Pick<CapabilityVersion, 'pin' | 'reason'>[],
): Promise<void> {
  for (const bundled of baseline) {
    const snapshot = await ledger.snapshot();
    const current = snapshot.versions.find(
      (value) => capabilityKey(value.pin) === capabilityKey(bundled.pin),
    );
    if (current !== undefined) continue;
    const now = new Date();
    try {
      await ledger.change(
        {
          kind: 'version',
          command: {
            commandId: randomUUID(),
            pin: bundled.pin,
            state: 'draft',
            reason: 'Bundled capability release registration',
            expectedRevision: 0,
          },
        },
        'service:release',
        now,
      );
      await ledger.change(
        {
          kind: 'version',
          command: {
            commandId: randomUUID(),
            pin: bundled.pin,
            state: 'published',
            reason: bundled.reason,
            expectedRevision: 1,
          },
        },
        'service:release',
        now,
      );
    } catch (error) {
      if (!(error instanceof SuspensionConflict)) throw error;
      // Another instance/operator won. Honor that state; never advance it automatically.
    }
  }
}
