import type { SegmentConfig } from './config.js';
import type { ModelGate } from './model.js';
import type { SourcePort } from './sources/port.js';
import type { Sealer } from '@agent-works/domain/sealer';
import type { IncomingHttpHeaders } from 'node:http';
import type postgres from 'postgres';

/** A verified, entitled member of this segment. Only `routes.ts` constructs one. */
export type Member = {
  readonly sub: string;
  readonly email: string;
  /** Absent for members built outside `routes.ts`, which then fail the admin check closed. */
  readonly admin?: boolean;
};

/**
 * Live membership source (a directory). Absent means the static `config.members` allowlist. A
 * throw is a failed lookup, never an answer: the gateway reads it as retryable, not as removed.
 */
type MemberDirectory = { isMember(email: string): Promise<boolean> };

export type Deps = {
  readonly directory?: MemberDirectory;
  readonly sql: postgres.Sql;
  readonly config: SegmentConfig;
  readonly gate: ModelGate;
  readonly sources: SourcePort;
  readonly sealer: Sealer;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly fetch: typeof fetch;
  /** `AW_STRICT_PROPOSALS=on`: coordinator plans are validated whole instead of leniently trimmed. */
  readonly strictProposals?: boolean;
};

export type Tx = postgres.TransactionSql;

export type Request = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
};

export type Reply = { readonly status: number; readonly body: unknown };

/**
 * A command refused by the current state; the code is stable and member-facing text lives in web.
 * `detail` carries what only the server knows about this refusal (which row, which limit) and is
 * safe to show as-is.
 */
export class Conflict extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    readonly detail?: string,
  ) {
    super(code);
    this.name = 'Conflict';
  }
}

export async function audit(
  deps: Deps,
  tx: Tx | postgres.Sql,
  entry: {
    readonly ownerSub: string | null;
    readonly taskId?: string | null;
    readonly assignmentId?: string | null;
    readonly action: string;
    readonly outcome: string;
    readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
  },
): Promise<void> {
  await tx`
    insert into tw_audit (at, owner_sub, task_id, assignment_id, action, outcome, detail)
    values (${deps.now()}, ${entry.ownerSub}, ${entry.taskId ?? null}, ${entry.assignmentId ?? null},
      ${entry.action}, ${entry.outcome}, ${tx.json(entry.detail ?? {})})
  `;
}
