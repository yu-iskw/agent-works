import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { createPostgresAuditLog } from './write.js';

import type { AuditLog } from './write.js';
import type { AuditEvent } from '@agent-works/domain';
import type postgres from 'postgres';

const digest = 'd10518952801d94803ef1162ec3fefbea9dfe82690ef52065439be6b3d55dd59';
const eventId = '11111111-1111-4111-8111-111111111111';

type Seed = {
  audits?: readonly string[];
  reservations?: readonly string[];
};

describe('postgres ask reservation', () => {
  it('does not hold a pooled connection while the ask runs', async () => {
    const db = fakeDatabase();
    const reply = { status: 200, body: { answer: 'from-this-call' } };
    const result = await auditLog(db).run(eventId, () => Promise.resolve(produced(reply)));
    expect(result).toEqual({ kind: 'done', reply });
  });

  it('returns conflict after the same id succeeds', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    const reply = { status: 200, body: { answer: 'once' } };
    let runs = 0;
    const first = await log.run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced(reply));
    });
    const second = await log.run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced({ status: 200, body: { answer: 'twice' } }));
    });
    expect(first).toEqual({ kind: 'done', reply });
    expect(second).toEqual({ kind: 'conflict' });
    expect(runs).toBe(1);
  });

  it('returns conflict to a duplicate while the first ask is still running', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    const reply = { status: 200, body: { answer: 'first' } };
    let runs = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = log.run(eventId, async () => {
      runs += 1;
      await gate;
      return produced(reply);
    });
    await waitUntil(() => runs === 1);
    const second = await log.run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced({ status: 200, body: { answer: 'second' } }));
    });
    expect(second).toEqual({ kind: 'conflict' });
    release();
    expect(await first).toEqual({ kind: 'done', reply });
    expect(runs).toBe(1);
  });

  it('returns conflict when an audit row already exists', async () => {
    const db = fakeDatabase({ audits: [eventId] });
    let runs = 0;
    const result = await auditLog(db).run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced({ status: 200, body: { answer: 'fresh' } }));
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(runs).toBe(0);
    expect(db.reservations()).toEqual([]);
  });

  it('returns conflict when the request id is already reserved', async () => {
    const db = fakeDatabase({ reservations: [eventId] });
    let runs = 0;
    const result = await auditLog(db).run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced({ status: 200, body: { answer: 'fresh' } }));
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(runs).toBe(0);
    expect(db.reservations()).toEqual([eventId]);
  });

  it('runs again after the first execution throws', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    let runs = 0;
    await expect(
      log.run(eventId, () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    const reply = { status: 200, body: { answer: 'retried' } };
    const result = await log.run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced(reply));
    });
    expect(result).toEqual({ kind: 'done', reply });
    expect(runs).toBe(2);
    expect(db.reservations()).toEqual([eventId]);
  });

  it('keeps the reservation when the audit insert throws', async () => {
    const db = fakeDatabase();
    db.failAuditInsert = true;
    const log = auditLog(db);
    let runs = 0;
    await expect(
      log.run(eventId, () => {
        runs += 1;
        return Promise.resolve(produced({ status: 200, body: { answer: 'lost' } }));
      }),
    ).rejects.toMatchObject({ name: 'AuditWriteError', message: 'audit write' });
    expect(db.reservations()).toEqual([eventId]);
    db.failAuditInsert = false;
    const second = await log.run(eventId, () => {
      runs += 1;
      return Promise.resolve(produced({ status: 200, body: { answer: 'again' } }));
    });
    expect(second).toEqual({ kind: 'conflict' });
    expect(runs).toBe(1);
  });
});

function auditLog(db: FakeDatabase): AuditLog {
  return createPostgresAuditLog(db.sql as unknown as postgres.Sql);
}

function produced(reply: { status: number; body: unknown }): {
  event: AuditEvent;
  reply: { status: number; body: unknown };
} {
  return { event: eventFor(reply.status), reply };
}

function eventFor(status: number): AuditEvent {
  return {
    eventId,
    eventType: 'ask',
    schemaVersion: '1',
    occurredAt: '2026-10-10T10:00:00.000Z',
    taskId: eventId,
    stepId: 'ask',
    traceId: '11111111111141118111111111111111',
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:scripted-runner',
    tool: 'drive.list',
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: digest,
    outcome: status === 200 ? 'answered' : 'retrieval_failed',
    externalObjectRef: null,
    prevDigest: null,
  };
}

async function waitUntil(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 1000) throw new Error('timed out');
    await delay(5);
  }
}

type FakeDatabase = {
  sql: FakeSql;
  reservations: () => readonly string[];
  failAuditInsert: boolean;
};

type FakeSql = {
  (first: unknown, ...rest: unknown[]): Promise<unknown[]> | { row: Record<string, unknown> };
  reserve: () => never;
};

function fakeDatabase(seed: Seed = {}): FakeDatabase {
  const reservations = new Set<string>(seed.reservations ?? []);
  const audits = new Set<string>(seed.audits ?? []);
  const flags = { failAuditInsert: false };
  const sql = ((first: unknown, ...values: unknown[]) => {
    if (!isTemplate(first)) {
      if (flags.failAuditInsert) throw new Error('audit insert');
      const row = first as Record<string, unknown>;
      audits.add(String(row.event_id));
      return { row };
    }
    return Promise.resolve(apply(stringsOf(first), values));
  }) as FakeSql;
  sql.reserve = () => {
    throw new Error('pooled connection');
  };
  return {
    sql,
    reservations: () => [...reservations],
    get failAuditInsert() {
      return flags.failAuditInsert;
    },
    set failAuditInsert(value: boolean) {
      flags.failAuditInsert = value;
    },
  };

  function apply(sqlText: string, values: readonly unknown[]): unknown[] {
    if (sqlText.includes('delete from ask_reservations')) {
      reservations.delete(text(values[0]));
      return [];
    }
    if (sqlText.includes('insert into ask_reservations')) {
      const requestId = text(values[0]);
      if (audits.has(requestId) || reservations.has(requestId)) return [];
      reservations.add(requestId);
      return [{ request_id: requestId }];
    }
    if (sqlText.includes('insert into audit_events')) return [];
    throw new Error(`unexpected sql: ${sqlText}`);
  }
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Object.hasOwn(value, 'raw');
}

function stringsOf(value: TemplateStringsArray): string {
  return value.join(' ');
}

function text(value: unknown): string {
  return String(value);
}
