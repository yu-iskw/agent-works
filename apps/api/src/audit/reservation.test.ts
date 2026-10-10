import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { AuditWriteError, createPostgresAuditLog } from './write.js';

import type { AuditLog } from './write.js';
import type { AuditEvent } from '@agent-works/domain';
import type postgres from 'postgres';

const digest = 'd10518952801d94803ef1162ec3fefbea9dfe82690ef52065439be6b3d55dd59';
const eventId = '11111111-1111-4111-8111-111111111111';

type ReplayRow = {
  initiator_subject: string;
  request_digest_sha256: string;
  response_status: number | null;
  response_body: string | null;
};

type Snapshot = {
  replays: Map<string, ReplayRow>;
  audits: Set<string>;
};

type Seed = {
  audits?: readonly string[];
  openReplays?: readonly { requestId: string; initiatorSubject: string }[];
};

describe('postgres ask reservation', () => {
  it('leaves the pool free while the ask runs', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    let reservedDuringExecute = -1;
    const result = await log.run(claim(), () => {
      reservedDuringExecute = db.reserved();
      return Promise.resolve(produced(200));
    });
    expect(reservedDuringExecute).toBe(0);
    expect(result).toEqual({ kind: 'done', reply: produced(200).reply });
    expect(db.reserved()).toBe(0);
  });

  it('returns the first reply when two logs share one request id', async () => {
    const db = fakeDatabase();
    const firstLog = auditLog(db);
    const secondLog = auditLog(db);
    let runs = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = firstLog.run(claim(), async () => {
      runs += 1;
      await gate;
      return produced(200);
    });
    await waitUntil(() => runs === 1);
    const second = secondLog.run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    release();
    expect(await first).toEqual({ kind: 'done', reply: produced(200).reply });
    expect(await second).toEqual({ kind: 'done', reply: produced(200).reply });
    expect(runs).toBe(1);
    expect(db.reserved()).toBe(0);
  });

  it('returns conflict when the request id already has an audit row', async () => {
    const db = fakeDatabase({ audits: [eventId] });
    let runs = 0;
    const result = await auditLog(db).run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(runs).toBe(0);
  });

  it('returns conflict and drops an open replay when the audit row already exists', async () => {
    const db = fakeDatabase({
      audits: [eventId],
      openReplays: [{ requestId: eventId, initiatorSubject: 'alice' }],
    });
    let runs = 0;
    const result = await auditLog(db).run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    expect(result).toEqual({ kind: 'conflict' });
    expect(runs).toBe(0);
    expect(db.replay(eventId)).toBeUndefined();
  });

  it('returns conflict when another caller reuses the request id', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    let runs = 0;
    const first = await log.run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    const second = await log.run(claim('bob'), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    expect(first).toEqual({ kind: 'done', reply: produced(200).reply });
    expect(second).toEqual({ kind: 'conflict' });
    expect(runs).toBe(1);
  });

  it('returns conflict when the stored reply failed', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    let runs = 0;
    const first = await log.run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(502));
    });
    const second = await log.run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    expect(first).toEqual({ kind: 'done', reply: produced(502).reply });
    expect(second).toEqual({ kind: 'conflict' });
    expect(runs).toBe(1);
  });

  it('stops waiting when a reservation has no live owner', async () => {
    const db = fakeDatabase({
      openReplays: [{ requestId: eventId, initiatorSubject: 'alice' }],
    });
    const log = createPostgresAuditLog(db.sql as unknown as postgres.Sql, 40);
    let runs = 0;
    const outcome = await Promise.race([
      log
        .run(claim(), () => {
          runs += 1;
          return Promise.resolve(produced(200));
        })
        .then(
          (result) => ({ status: 'returned' as const, result }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        ),
      delay(500).then(() => ({ status: 'waiting' as const })),
    ]);

    expect(outcome).toEqual({
      status: 'rejected',
      error: expect.any(AuditWriteError),
    });
    expect(runs).toBe(0);
    expect(db.replay(eventId)).toEqual({
      initiator_subject: 'alice',
      request_digest_sha256: digest,
      response_status: null,
      response_body: null,
    });
    expect(db.reserved()).toBe(0);
  });

  it('runs again after the first execution throws', async () => {
    const db = fakeDatabase();
    const log = auditLog(db);
    let runs = 0;
    await expect(
      log.run(claim(), () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    const result = await log.run(claim(), () => {
      runs += 1;
      return Promise.resolve(produced(200));
    });
    expect(result).toEqual({ kind: 'done', reply: produced(200).reply });
    expect(runs).toBe(2);
    expect(db.reserved()).toBe(0);
  });
});

function auditLog(db: FakeDatabase): AuditLog {
  return createPostgresAuditLog(db.sql as unknown as postgres.Sql);
}

function claim(initiatorSubject = 'alice') {
  return { eventId, initiatorSubject, requestDigestSha256: digest };
}

function produced(status: number): { event: AuditEvent; reply: { status: number; body: unknown } } {
  return {
    event: {
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
    },
    reply: { status, body: { answer: 'stored-answer' } },
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
  sql: { reserve: () => Promise<FakeConnection> };
  reserved: () => number;
  replay: (requestId: string) => ReplayRow | undefined;
};

type FakeConnection = {
  (first: unknown, ...rest: unknown[]): Promise<QueryResult> | { row: Record<string, unknown> };
  unsafe: (query: string) => Promise<QueryResult>;
  release: () => void;
};

type QueryResult = unknown[] & { count: number };

type Statement =
  | 'lock'
  | 'unlock'
  | 'read-replay'
  | 'read-audit'
  | 'insert-replay'
  | 'insert-audit'
  | 'delete-replay'
  | 'update-replay';

function fakeDatabase(seed: Seed = {}): FakeDatabase {
  const replays = new Map<string, ReplayRow>();
  const audits = new Set<string>(seed.audits ?? []);
  const sessions = new Map<number, Snapshot | undefined>();
  const heldBy = new Map<string, number>();
  const waiters = new Map<string, (() => void)[]>();
  let reserved = 0;
  let nextSession = 0;
  for (const replay of seed.openReplays ?? []) {
    replays.set(replay.requestId, {
      initiator_subject: replay.initiatorSubject,
      request_digest_sha256: digest,
      response_status: null,
      response_body: null,
    });
  }
  return {
    reserved: () => reserved,
    replay: (requestId) => replays.get(requestId),
    sql: {
      reserve() {
        reserved += 1;
        const sessionId = ++nextSession;
        sessions.set(sessionId, undefined);
        return Promise.resolve(connection());

        function connection(): FakeConnection {
          const tag = (first: unknown, ...rest: unknown[]) => {
            if (isTemplate(first)) return applyQuery(stringsOf(first), rest);
            return { row: first as Record<string, unknown> };
          };
          tag.unsafe = (query: string) => {
            applyUnsafe(query);
            return Promise.resolve(empty());
          };
          tag.release = () => {
            if (sessions.get(sessionId) !== undefined) restore(sessionId);
            releaseLocks(sessionId);
            sessions.delete(sessionId);
            reserved -= 1;
          };
          return tag;
        }

        function applyQuery(sqlText: string, values: readonly unknown[]): Promise<QueryResult> {
          const [first] = values;
          const kind = classify(sqlText);
          switch (kind) {
            case 'lock':
              return acquire(text(first), sessionId).then(() => empty());
            case 'unlock':
              unlock(text(first), sessionId);
              return Promise.resolve(empty());
            case 'read-replay':
              return Promise.resolve(readReplay(text(first)));
            case 'read-audit':
              return Promise.resolve(readAudit(text(first)));
            case 'insert-replay':
              insertReplay(values);
              return Promise.resolve(empty());
            case 'insert-audit':
              insertAudit(values);
              return Promise.resolve(empty());
            case 'delete-replay':
              deleteReplay(text(first));
              return Promise.resolve(empty());
            case 'update-replay':
              return Promise.resolve(updateReplay(values));
            default: {
              const unexpected: never = kind;
              return Promise.reject(new Error(unexpected));
            }
          }
        }

        function applyUnsafe(query: string): void {
          if (query === 'begin') {
            sessions.set(sessionId, snapshot());
            return;
          }
          if (query === 'commit') {
            sessions.set(sessionId, undefined);
            return;
          }
          if (query === 'rollback') {
            restore(sessionId);
            return;
          }
          throw new Error(`unexpected sql: ${query}`);
        }

        function readReplay(requestId: string): QueryResult {
          const row = replays.get(requestId);
          return row === undefined ? empty() : result([row]);
        }

        function readAudit(id: string): QueryResult {
          return audits.has(id) ? result([{ event_id: id }]) : empty();
        }

        function insertReplay(values: readonly unknown[]): void {
          const [requestId, initiatorSubject, requestDigestSha256] = values;
          replays.set(text(requestId), {
            initiator_subject: text(initiatorSubject),
            request_digest_sha256: text(requestDigestSha256),
            response_status: null,
            response_body: null,
          });
        }

        function insertAudit(values: readonly unknown[]): void {
          const helper = values[0] as { row: Record<string, unknown> };
          audits.add(String(helper.row.event_id));
        }

        function deleteReplay(requestId: string): void {
          const row = replays.get(requestId);
          if (row?.response_body === null) replays.delete(requestId);
        }

        function updateReplay(values: readonly unknown[]): QueryResult {
          const [status, responseBody, requestId] = values;
          const id = text(requestId);
          const row = replays.get(id);
          if (row === undefined) return empty();
          replays.set(id, {
            ...row,
            response_status: status as number,
            response_body: text(responseBody),
          });
          return result([id]);
        }

        function snapshot(): Snapshot {
          return {
            replays: new Map([...replays].map(([id, row]) => [id, { ...row }])),
            audits: new Set(audits),
          };
        }

        function restore(id: number): void {
          const saved = sessions.get(id);
          if (saved === undefined) return;
          replays.clear();
          for (const [replayId, row] of saved.replays) replays.set(replayId, row);
          audits.clear();
          for (const auditId of saved.audits) audits.add(auditId);
          sessions.set(id, undefined);
        }
      },
    },
  };

  function acquire(id: string, sessionId: number): Promise<void> {
    if (!heldBy.has(id)) {
      heldBy.set(id, sessionId);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const queue = waiters.get(id) ?? [];
      queue.push(() => {
        heldBy.set(id, sessionId);
        resolve();
      });
      waiters.set(id, queue);
    });
  }

  function unlock(id: string, sessionId: number): void {
    if (heldBy.get(id) !== sessionId) return;
    heldBy.delete(id);
    const next = waiters.get(id)?.shift();
    if (next !== undefined) next();
  }

  function releaseLocks(sessionId: number): void {
    for (const id of [...heldBy.keys()]) {
      if (heldBy.get(id) === sessionId) unlock(id, sessionId);
    }
  }
}

function classify(text: string): Statement {
  if (text.includes('pg_advisory_unlock')) return 'unlock';
  if (text.includes('pg_advisory_lock')) return 'lock';
  if (text.includes('insert into ask_replays')) return 'insert-replay';
  if (text.includes('insert into audit_events')) return 'insert-audit';
  if (text.includes('delete from ask_replays')) return 'delete-replay';
  if (text.includes('update ask_replays')) return 'update-replay';
  if (text.includes('from ask_replays')) return 'read-replay';
  if (text.includes('from audit_events')) return 'read-audit';
  throw new Error(`unexpected sql: ${text}`);
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

function empty(): QueryResult {
  return result([]);
}

function result(items: unknown[]): QueryResult {
  return Object.assign([...items], { count: items.length });
}
