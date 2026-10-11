import { canonicalPayloadSha256 } from '@agent-works/domain';
import { createTicket, listen } from '@agent-works/fakes';
import { decide } from '@agent-works/policy';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';
import { createMemoryLedgerPort } from '../ports/memory/ledger-port.js';

import { applyApprovalsMigration, createPostgresApprovalStore } from './approvals.js';
import { TICKET_TOOL, createBroker } from './broker.js';

import type { Broker, ExecuteInput } from './broker.js';
import type { Approval, PolicyClause } from '@agent-works/domain';
import type { Sql } from 'postgres';

const now = new Date('2026-10-11T12:00:00.000Z');

export const allowedFacts = {
  authenticated_actor: true,
  active_org_membership: true,
  permitted_app_role: true,
  approved_agent_and_skill_version: true,
  agent_has_tool_capability: true,
  user_or_service_has_resource_authority: true,
  source_system_allows_operation: true,
  data_classification_policy_allows: true,
  valid_approval_if_required: true,
  within_time_and_budget_bounds: true,
} as const satisfies { readonly [Clause in PolicyClause]: boolean };

const payload = { summary: 'Ship the fix', project: 'PROJ' };

type ExecutePatch = {
  readonly id?: string;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly idempotencyKey?: string;
  readonly approvalId?: string;
  readonly traceId?: string;
  readonly actorSub?: string;
  readonly toolRef?: string;
  readonly targetResource?: string;
  readonly payload?: unknown;
  readonly facts?: ExecuteInput['facts'];
};

export type ApprovalHarness = {
  readonly digest: string;
  readonly broker: Broker;
  row(patch?: Partial<Approval>): Approval;
  save(approval: Approval): Promise<void>;
  read(id: string): Promise<Approval | undefined>;
  execute(patch?: ExecutePatch): Promise<Awaited<ReturnType<Broker['execute']>>>;
  posts(): number;
  tickets(): Promise<number>;
  intentBeforePost(): boolean;
  failNextPost(): void;
  stop(): Promise<void>;
};

export async function createApprovalHarness(
  sql: Sql,
  approverAuthorized: (sub: string) => boolean = () => true,
): Promise<ApprovalHarness> {
  const server = await listen(createTicket(), 0);
  const store = createPostgresApprovalStore(sql);
  let posts = 0;
  let failedPosts = 0;
  let intended = false;
  let postedEarly = false;
  const inner = createMemoryLedgerPort(() => now);
  const ledger = {
    submit: inner.submit.bind(inner),
    read: inner.read.bind(inner),
    append(event: Parameters<typeof inner.append>[0]) {
      if (event.event.outcome === 'INTENDED') intended = true;
      return inner.append(event);
    },
  };
  const broker = createBroker({
    store,
    decide,
    ledger,
    approverAuthorized,
    now: () => now,
    async postTicket(body, idempotencyKey) {
      if (!intended) postedEarly = true;
      if (failedPosts > 0) {
        failedPosts -= 1;
        throw new Error('ticket transport');
      }
      posts += 1;
      const response = await fetch(`${server.url}/tickets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      return readReceipt(await response.json());
    },
  });
  const digest = canonicalPayloadSha256(payload);
  return {
    digest,
    broker,
    row(patch = {}) {
      return {
        id: 'apr-1',
        taskId: 'tsk-1',
        stepId: 'step-1',
        tool: TICKET_TOOL,
        targetResource: 'PROJ',
        payloadSha256: digest,
        requestedBySub: 'alice',
        approverSub: 'bob',
        state: 'approved',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxExecutions: 1,
        executionsUsed: 0,
        ...patch,
      };
    },
    save(approval) {
      return store.save(approval);
    },
    read(id) {
      return store.read(id);
    },
    execute(patch = {}) {
      return broker.execute({
        id: patch.id ?? 'call-1',
        taskId: patch.taskId ?? 'tsk-1',
        stepId: patch.stepId ?? 'step-1',
        toolRef: patch.toolRef ?? TICKET_TOOL,
        idempotencyKey: patch.idempotencyKey ?? 'key-1',
        targetResource: patch.targetResource ?? 'PROJ',
        payload: patch.payload === undefined ? payload : patch.payload,
        approvalId: patch.approvalId ?? 'apr-1',
        actorSub: patch.actorSub ?? 'alice',
        traceId: patch.traceId ?? 'trace-1',
        facts: patch.facts ?? allowedFacts,
      });
    },
    posts: () => posts,
    async tickets() {
      const response = await fetch(`${server.url}/tickets`);
      return readTicketCount(await response.json());
    },
    intentBeforePost: () => intended && !postedEarly,
    failNextPost() {
      failedPosts += 1;
    },
    stop: () => server.close(),
  };
}

export function useApprovalDatabase(): { sql(): Sql } {
  let sql: Sql | undefined;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    const database = await startDisposablePostgres();
    sql = openSql(database.url);
    await applyApprovalsMigration(sql);
    close = async () => {
      await sql?.end({ timeout: 1 });
      await database.stop();
    };
  }, 60_000);
  afterAll(async () => {
    await close?.();
  });
  beforeEach(async () => {
    if (sql === undefined) throw new Error('postgres');
    await sql`truncate table tool_calls, approvals`;
  });
  return {
    sql() {
      if (sql === undefined) throw new Error('postgres');
      return sql;
    },
  };
}

function readReceipt(body: unknown): string {
  if (typeof body !== 'object' || body === null || !('receipt' in body)) {
    throw new Error('ticket receipt missing');
  }
  if (typeof body.receipt !== 'string') throw new Error('ticket receipt missing');
  return body.receipt;
}

function readTicketCount(body: unknown): number {
  if (typeof body !== 'object' || body === null || !('tickets' in body)) return 0;
  return Array.isArray(body.tickets) ? body.tickets.length : 0;
}
