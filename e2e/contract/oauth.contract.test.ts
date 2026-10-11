import { createHash } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createOAuthFlow } from '../../apps/api/src/credentials/flow.js';
import {
  applyCredentialsMigration,
  createPostgresCredentialStore,
} from '../../apps/api/src/credentials/postgres.js';
import { createHttpOAuthProvider } from '../../apps/api/src/credentials/provider.js';
import { openSql, startDisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import {
  applyTaskLedgerMigration,
  createPostgresLedgerPort,
} from '../../apps/api/src/ledger/postgres-ledger.js';
import { createOAuth } from '../../packages/fakes/src/fake-oauth.js';
import { listen } from '../../packages/fakes/src/http.js';
import { appendResult } from '../results.mjs';

import type { DisposablePostgres } from '../../apps/api/src/ledger/disposable-postgres.js';
import type { OAuthStart, OutboxEvent, TaskSubmit } from '@agent-works/domain';

const verifier = 'verifier-value-which-is-long-enough';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const canary = 'canary-do-not-log';
const at = new Date('2026-10-10T10:00:00.000Z');

const submit: TaskSubmit = {
  objective: 'Summarize the runbook',
  skillId: 'ask',
  sourceAllowlist: ['drive'],
  requestedOutputs: ['answer'],
  executionPolicy: { mode: 'interactive', budgetUsd: 0.1, deadlineSeconds: 30 },
};

let database: DisposablePostgres | undefined;
let sql: ReturnType<typeof openSql> | undefined;
let closeOAuth: (() => Promise<void>) | undefined;

beforeAll(async () => {
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  await applyCredentialsMigration(sql);
  await applyTaskLedgerMigration(sql);
}, 60_000);

afterAll(async () => {
  await closeOAuth?.();
  await sql?.end({ timeout: 1 });
  await database?.stop();
});

it('oauth.blocked-auth', async () => {
  if (sql === undefined) throw new Error('postgres');
  const server = await listen(createOAuth(), 0);
  closeOAuth = server.close;
  let instant = new Date('2026-10-10T10:00:00.000Z');
  const store = createPostgresCredentialStore(sql);
  const ledger = createPostgresLedgerPort(sql, () => at);
  const flow = createOAuthFlow({
    credentials: store.credentials,
    grants: store.grants,
    provider: createHttpOAuthProvider(server.url),
    ledger,
    now: () => instant,
  });
  const start: OAuthStart = {
    provider: 'fake',
    state: 'state-1',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    scope: 'ticket.create',
  };
  await flow.begin('alice', start);
  const authorized = await fetch(`${server.url}/oauth/authorize`, {
    method: 'POST',
    body: JSON.stringify({ subject: 'alice', ...start }),
  });
  const authorizedBody: unknown = await authorized.json();
  if (!isRecord(authorizedBody) || typeof authorizedBody.code !== 'string') throw new Error('code');
  const saved = await flow.complete('alice', {
    provider: 'fake',
    state: 'state-1',
    code: authorizedBody.code,
    codeVerifier: verifier,
  });
  expect(saved).toEqual({
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'token-1',
  });
  expect(JSON.stringify(saved).includes(canary)).toBe(false);

  const accepted = await ledger.submit('alice', submit, 'oauth-block');
  await ledger.transition({
    subject: 'alice',
    taskId: accepted.taskId,
    expectedVersion: 1,
    to: 'RUNNING',
    event: outbox('evt-run', accepted.taskId),
  });
  instant = new Date('2100-01-01T00:00:00.000Z');
  const blocked = await flow.blockIfStale('alice', 'fake', accepted.taskId);
  expect(blocked.status).toBe('BLOCKED_AUTH');
  expect(blocked.version).toBe(3);
  expect(await store.credentials.read('alice', 'fake')).toEqual({
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'expired',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'token-1',
  });
  const rows = await sql<{ payload: unknown }[]>`
    select payload from outbox_events where event_id = ${`auth-${accepted.taskId}-2`}
  `;
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0]?.payload).includes(canary)).toBe(false);
  appendResult({ id: 'oauth.blocked-auth', status: 'passed' });
});

function outbox(eventId: string, taskId: string): OutboxEvent {
  return {
    destination: 'work',
    event: {
      eventId,
      eventType: 'task',
      schemaVersion: '1',
      occurredAt: '2026-10-10T10:00:00.000Z',
      taskId,
      stepId: 'transition',
      traceId: 'trace',
      initiatorSubject: 'alice',
      agentPrincipal: 'agent:postgres',
      tool: null,
      policyDecisionId: null,
      approvalId: null,
      requestDigestSha256: null,
      outcome: 'SUCCESS',
      externalObjectRef: null,
      prevDigest: null,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
