import { isDeepStrictEqual } from 'node:util';

import { dlqEntrySchema } from './dlq-types.js';

import type { DlqDecision, DlqStore } from './dlq-types.js';
import type postgres from 'postgres';

export function createPostgresDlqStore(sql: postgres.Sql): DlqStore {
  return {
    async add(input) {
      const entry = dlqEntrySchema.parse(input);
      await sql`insert into reliability_dlq(entry_id, task_id, idempotency_key, subject, risky_write, state, version, payload)
        values (${entry.entryId}, ${entry.taskId}, ${entry.idempotencyKey}, ${entry.subject}, ${entry.riskyWrite}, ${entry.state}, ${entry.version}, ${sql.json(entry)})
        on conflict(entry_id) do nothing`;
      const rows = await sql<
        { payload: unknown }[]
      >`select payload from reliability_dlq where entry_id = ${entry.entryId}`;
      const previous = dlqEntrySchema.parse(rows[0].payload);
      if (JSON.stringify(previous) !== JSON.stringify(entry))
        throw new Error('DLQ identity conflict');
      return previous;
    },
    async read(id) {
      const rows = await sql<
        { payload: unknown }[]
      >`select payload from reliability_dlq where entry_id = ${id}`;
      return rows.length === 0 ? undefined : dlqEntrySchema.parse(rows[0].payload);
    },
    async list() {
      const rows = await sql<
        { payload: unknown }[]
      >`select payload from reliability_dlq order by entry_id`;
      return rows.map((row) => dlqEntrySchema.parse(row.payload));
    },
    async decide(entry, decision, expectedVersion) {
      dlqEntrySchema.parse(entry);
      if (entry.version !== expectedVersion + 1) throw new Error('DLQ version conflict');
      await sql.begin(async (tx) => {
        const rows = await tx<
          { version: number }[]
        >`select version from reliability_dlq where entry_id = ${entry.entryId} for update`;
        const previous = await tx<
          { payload: DlqDecision }[]
        >`select payload from reliability_dlq_decisions where decision_id = ${decision.decisionId}`;
        if (previous.length > 0) {
          if (!isDeepStrictEqual(previous[0].payload, decision))
            throw new Error('DLQ decision identity conflict');
          return;
        }
        if (rows.at(0)?.version !== expectedVersion) throw new Error('DLQ version conflict');
        await tx`update reliability_dlq set state = ${entry.state}, version = ${entry.version}, payload = ${tx.json(entry)} where entry_id = ${entry.entryId}`;
        await tx`insert into reliability_dlq_decisions(decision_id, entry_id, payload) values (${decision.decisionId}, ${entry.entryId}, ${tx.json(decision)})`;
      });
    },
    async decisions() {
      const rows = await sql<
        { payload: DlqDecision }[]
      >`select payload from reliability_dlq_decisions order by decision_id`;
      return rows.map((row) => row.payload);
    },
  };
}
