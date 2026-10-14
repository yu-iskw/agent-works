import * as z from 'zod';

export const dlqEntrySchema = z.strictObject({
  entryId: z.string().min(1),
  taskId: z.string().min(1),
  subject: z.string().min(1),
  idempotencyKey: z.string().min(1),
  riskyWrite: z.boolean(),
  reason: z.enum(['deadline', 'retry_exhausted', 'unknown_receipt', 'stuck']),
  state: z.enum(['review', 'requeue_pending', 'requeued', 'compensated']),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type DlqEntry = z.infer<typeof dlqEntrySchema>;
export type DlqDecision = {
  readonly decisionId: string;
  readonly entryId: string;
  readonly operator: string;
  readonly reason: string;
  readonly action: 'requeue' | 'compensate';
  readonly evidenceRef: string | null;
  readonly occurredAt: string;
};
export interface DlqStore {
  add(entry: DlqEntry): Promise<DlqEntry>;
  read(entryId: string): Promise<DlqEntry | undefined>;
  list(): Promise<readonly DlqEntry[]>;
  /** Version check and evidence append commit atomically. */
  decide(entry: DlqEntry, decision: DlqDecision, expectedVersion: number): Promise<void>;
  decisions(): Promise<readonly DlqDecision[]>;
}
