import { dlqEntrySchema } from './dlq-types.js';

import type { DlqDecision, DlqEntry, DlqStore } from './dlq-types.js';

export function createMemoryDlqStore(): DlqStore {
  const entries = new Map<string, DlqEntry>();
  const evidence = new Map<string, DlqDecision>();
  return {
    add(input) {
      const entry = dlqEntrySchema.parse(input);
      const prior = entries.get(entry.entryId);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(entry))
        throw new Error('DLQ identity conflict');
      if (
        [...entries.values()].some(
          (row) =>
            row.entryId !== entry.entryId &&
            row.taskId === entry.taskId &&
            row.idempotencyKey === entry.idempotencyKey,
        )
      )
        throw new Error('DLQ task identity conflict');
      entries.set(entry.entryId, entry);
      return Promise.resolve(structuredClone(entry));
    },
    read(id) {
      return Promise.resolve(structuredClone(entries.get(id)));
    },
    list() {
      return Promise.resolve(
        structuredClone(
          [...entries.values()].sort((a, b) => a.entryId.localeCompare(b.entryId, 'en')),
        ),
      );
    },
    decide(entry, decision, expectedVersion) {
      const previous = entries.get(entry.entryId);
      const priorDecision = evidence.get(decision.decisionId);
      if (priorDecision !== undefined) {
        if (JSON.stringify(priorDecision) !== JSON.stringify(decision))
          throw new Error('DLQ decision identity conflict');
        return Promise.resolve();
      }
      if (previous?.version !== expectedVersion || entry.version !== expectedVersion + 1)
        throw new Error('DLQ version conflict');
      entries.set(entry.entryId, dlqEntrySchema.parse(entry));
      evidence.set(decision.decisionId, structuredClone(decision));
      return Promise.resolve();
    },
    decisions() {
      return Promise.resolve(structuredClone([...evidence.values()]));
    },
  };
}
