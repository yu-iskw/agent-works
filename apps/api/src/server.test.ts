import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { createPostgresAuditLog } from './audit/write.js';
import { createGroupResolver } from './auth/directory.js';
import { createPostgresLedgerPort } from './ledger/postgres-ledger.js';
import { createHttpDrive } from './retrieval/http-drive.js';
import { createAskRoute } from './routes/ask.js';

import type * as auditModule from './audit/write.js';
import type * as directoryModule from './auth/directory.js';
import type * as iapModule from './auth/iap.js';
import type { Caller } from './auth/iap.js';
import type * as configModule from './config.js';
import type { HttpDrive } from './retrieval/http-drive.js';

const caller = { sub: 'alice', assertion: 'verified-assertion' } as Caller;

vi.mock('node:http', () => ({ createServer: vi.fn(() => ({ listen: vi.fn() })) }));
vi.mock('./app.js', () => ({ createApp: vi.fn(() => () => undefined) }));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof configModule>()),
  loadConfig: () => ({
    port: 8080,
    databaseUrl: 'postgres://test',
    driveUrl: 'https://drive.test',
    directoryUrl: 'https://directory.test',
    llmUrl: 'https://llm.test',
    iap: {},
  }),
}));
vi.mock('./db.js', () => ({ openDatabase: () => Promise.resolve({}) }));
vi.mock('./auth/iap.js', async (importOriginal) => ({
  ...(await importOriginal<typeof iapModule>()),
  createIapVerifier: () => () => Promise.resolve(caller),
}));
vi.mock('./auth/directory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof directoryModule>()),
  createGroupResolver: vi.fn(() =>
    vi.fn(() =>
      Promise.resolve({
        sub: 'alice',
        groups: ['agent-users@company.example'],
        observedAt: new Date().toISOString(),
      }),
    ),
  ),
}));
vi.mock('./audit/write.js', async (importOriginal) => {
  const original = await importOriginal<typeof auditModule>();
  return { ...original, createPostgresAuditLog: vi.fn(() => original.createMemoryAuditLog()) };
});
vi.mock('./ledger/postgres-ledger.js', async () => {
  const { createMemoryLedgerPort } = await import('./ports/memory/ledger-port.js');
  return { createPostgresLedgerPort: vi.fn(() => createMemoryLedgerPort()) };
});
vi.mock('./retrieval/http-drive.js', () => {
  const search = vi.fn(() => Promise.resolve([]));
  return {
    createHttpDrive: vi.fn(() => ({
      retrieve: vi.fn(),
      open: vi.fn(() => Promise.resolve({ port: { search } })),
    })),
  };
});

const request = () => ({
  method: 'POST',
  path: '/v1/ask',
  headers: {},
  body: Buffer.from(JSON.stringify({ requestId: randomUUID(), question: 'question' })),
});

describe('server composition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('supplies production wire with role checks, policy, task storage and ledger audit', async () => {
    vi.stubEnv('AGENT_RUNNER', 'scripted');
    await import('./server.js');
    const deps = vi.mocked(createApp).mock.calls[0][0];
    expect(deps.wire).toBeDefined();
    expect(createGroupResolver).toHaveBeenCalledWith({ baseUrl: 'https://directory.test' });
    expect(createHttpDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://drive.test',
        directoryUrl: 'https://directory.test',
      }),
    );
    const ledger = deps.wire?.ledger;
    if (ledger === undefined) throw new Error('missing wire');
    expect(createPostgresLedgerPort).toHaveBeenCalledTimes(1);
    const submit = vi.spyOn(ledger, 'submit');
    const append = vi.spyOn(ledger, 'append');
    const drive = deps.drive as HttpDrive;
    const open = vi.spyOn(drive, 'open');
    const retrieve = vi.spyOn(drive, 'retrieve');
    const audit = deps.audit;
    expect(createPostgresAuditLog).toHaveBeenCalledTimes(1);
    const run = vi.spyOn(audit, 'run');
    const route = createAskRoute(deps);
    expect(await route(request())).toMatchObject({ status: 200, body: { citations: [] } });
    expect(submit).toHaveBeenCalledWith(
      'alice',
      expect.objectContaining({ skillId: 'ask' }),
      expect.any(String),
    );
    expect(append).toHaveBeenCalledTimes(1);
    const recorded = append.mock.calls[0][0];
    expect(recorded).toMatchObject({
      destination: 'audit',
      event: { outcome: 'no_sources', tool: 'drive.search@1' },
    });
    expect(recorded.event.policyDecisionId).toEqual(expect.any(String));
    expect(run).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(caller);
    expect(retrieve).not.toHaveBeenCalled();
    const groups = vi.mocked(createGroupResolver).mock.results[0].value as ReturnType<
      typeof createGroupResolver
    >;
    vi.mocked(groups).mockResolvedValue({
      sub: 'alice',
      groups: [],
      observedAt: new Date().toISOString(),
    });
    expect(await route(request())).toEqual({ status: 403, body: { error: 'denied' } });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
