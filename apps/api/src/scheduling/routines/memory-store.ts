import type { CreateOutcome, RoutineRecord, RoutineStore } from './types.js';

export function createMemoryRoutineStore(): RoutineStore {
  const rows = new Map<string, RoutineRecord>();
  return {
    create(record, maxActive): Promise<CreateOutcome> {
      const prior = [...rows.values()].find(
        (r) => r.grantId === record.grantId && r.idempotencyKey === record.idempotencyKey,
      );
      if (prior !== undefined) {
        return Promise.resolve(
          prior.digest === record.digest
            ? { outcome: 'existing', record: prior }
            : { outcome: 'conflict' },
        );
      }
      const active = [...rows.values()].filter(
        (r) =>
          r.grantId === record.grantId &&
          r.state === 'active' &&
          Date.parse(r.expiresAt) > Date.parse(record.createdAt),
      ).length;
      if (active >= maxActive) return Promise.resolve({ outcome: 'fan_out_exceeded' });
      rows.set(record.routineId, record);
      return Promise.resolve({ outcome: 'created', record });
    },
    get: (id) => Promise.resolve(rows.get(id)),
    listActive: () => Promise.resolve([...rows.values()].filter((r) => r.state === 'active')),
    cancel(id, reason, at) {
      const row = rows.get(id);
      if (row === undefined || row.state === 'cancelled') return Promise.resolve(row);
      const next: RoutineRecord = {
        ...row,
        state: 'cancelled',
        cancelReason: reason,
        cancelledAt: at,
      };
      rows.set(id, next);
      return Promise.resolve(next);
    },
  };
}
