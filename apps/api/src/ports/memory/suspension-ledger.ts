import { canonicalPayloadSha256 } from '@agent-works/domain';

import { parseAdminCommand, prepareChange } from '../../suspension/mutation.js';
import { commandDigest, SuspensionConflict, validateDenial } from '../suspension-ledger.js';

import type { AdminResult, SuspensionAudit, SuspensionLedger } from '../suspension-ledger.js';
import type { CapabilityVersion, Suspension } from '@agent-works/domain';

const eventIdReused = 'event id reused';

export function createMemorySuspensionLedger(): SuspensionLedger {
  const suspensions = new Map<string, Suspension>();
  const versions = new Map<string, CapabilityVersion>();
  const events = new Map<string, SuspensionAudit>();
  const claims = new Map<string, { digest: string; result: AdminResult }>();
  return {
    snapshot: () =>
      Promise.resolve(
        structuredClone({
          suspensions: [...suspensions.values()],
          versions: [...versions.values()],
        }),
      ),
    history: () => Promise.resolve(structuredClone([...events.values()])),
    change(input, actorSub, at) {
      try {
        const parsed = parseAdminCommand(input);
        const digest = commandDigest(parsed, actorSub);
        const previous = claims.get(parsed.command.commandId);
        if (previous !== undefined) {
          if (previous.digest !== digest) throw new SuspensionConflict('command id reused');
          return Promise.resolve(structuredClone({ ...previous.result, replay: true }));
        }
        if (events.has(parsed.command.commandId)) throw new SuspensionConflict(eventIdReused);
        const prepared = prepareChange(parsed, actorSub, at, {
          suspensions: [...suspensions.values()],
          versions: [...versions.values()],
        });
        const { record } = prepared.result;
        if ('target' in record) suspensions.set(prepared.key, structuredClone(record));
        else versions.set(prepared.key, structuredClone(record));
        events.set(prepared.audit.eventId, structuredClone(prepared.audit));
        claims.set(parsed.command.commandId, { digest, result: structuredClone(prepared.result) });
        return Promise.resolve(structuredClone(prepared.result));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('mutation failed'));
      }
    },
    deny(event) {
      return Promise.resolve().then(() => {
        event = validateDenial(event);
        const prior = events.get(event.eventId);
        if (prior !== undefined && canonicalPayloadSha256(prior) !== canonicalPayloadSha256(event))
          throw new SuspensionConflict(eventIdReused);
        if (claims.has(event.eventId)) throw new SuspensionConflict(eventIdReused);
        events.set(event.eventId, structuredClone(event));
      });
    },
  };
}
