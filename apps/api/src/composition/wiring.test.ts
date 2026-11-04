import { describe, expect, it, vi } from 'vitest';

import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { assertStartup, ProductionStartupRejected } from '../startup/providers.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';

import { admittedSkill, AdmissionDenied } from './admission.js';
import { buildBackgroundLoops } from './background.js';
import { createDeliveryRoutes, DELIVERY_PATH } from './delivery.js';
import { readWiring, WiringConfigError } from './flags.js';
import { createGoogleQueueHttpClient, createOutboxQueuePublisher } from './google-queue.js';
import { buildQueuePublisher, buildTelemetry } from './parts.js';

import type { AdmissionService } from '../admission/postgres-admission.js';
import type { AdmissionResult } from '../admission/types.js';
import type { RegisteredSkill } from '../skills/incident.js';
import type postgres from 'postgres';

const productionBase = {
  AW_MODE: 'production',
  DATABASE_URL: 'postgres://app:pw@db.internal.example.com:5432/app',
  DRIVE_URL: 'https://drive.example.com',
  DIRECTORY_URL: 'https://directory.example.com',
  LLM_URL: 'https://llm.example.com',
  IAP_JWKS_URL: 'https://www.gstatic.com/iap/verify/public_key-jwk',
  IAP_ISSUER: 'https://cloud.google.com/iap',
  IAP_AUDIENCE: '/projects/1/global/backendServices/2',
  OAUTH_URL: 'https://oauth.example.com',
  OAUTH_REDIRECT_URI: 'https://app.example.com/oauth/callback',
};
const workerUrl = 'https://api.example.com/internal/deliveries';
const deliveryEnv = {
  AW_WORKER_DELIVERY: 'on',
  AW_WORKER_URL: workerUrl,
  AW_DISPATCHER_SA: 'dispatcher@proj.iam.gserviceaccount.com',
  AW_WORKER_LEASE_MS: '30000',
};

describe('flags: default off', () => {
  it('enables nothing from an empty or local environment', () => {
    expect(readWiring({})).toEqual({
      telemetry: false,
      opsDashboard: false,
      strictProposals: false,
    });
    expect(buildTelemetry(readWiring({}))).toBeUndefined();
  });

  it('only the exact value "on" switches a capability on', () => {
    const wiring = readWiring({
      AW_ADMISSION: 'true',
      AW_WORKER_DELIVERY: '1',
      AW_TELEMETRY: 'ON',
    });
    expect(wiring.admission).toBeUndefined();
    expect(wiring.delivery).toBeUndefined();
    expect(wiring.telemetry).toBe(false);
  });

  it('adds no provider report to a default production deployment', () => {
    const reports = assertStartup(productionBase);
    expect(reports.map((r) => r.name)).not.toContain('wiring-config');
  });
});

describe('flags: enabled', () => {
  it('parses a complete delivery configuration', () => {
    const wiring = readWiring(deliveryEnv);
    expect(wiring.delivery).toMatchObject({
      workerUrl,
      dispatcherEmails: ['dispatcher@proj.iam.gserviceaccount.com'],
      budget: { leaseMs: 30_000 },
    });
  });

  it('refuses to start with the missing names, never their values', () => {
    expect.assertions(3);
    try {
      readWiring({ AW_ADMISSION: 'on', AW_ADMISSION_SEGMENT: 'secret-segment' });
    } catch (error) {
      expect(error).toBeInstanceOf(WiringConfigError);
      const { message } = error as Error;
      expect(message).toContain('AW_ADMISSION_LEASE_MS');
      expect(message).not.toContain('secret-segment');
    }
  });

  it('rejects a worker URL that is not the delivery endpoint', () => {
    expect(() =>
      readWiring({ ...deliveryEnv, AW_WORKER_URL: 'https://api.example.com/other' }),
    ).toThrow(/AW_WORKER_URL/);
  });

  it('rejects standing grants switched on without an approval reference', () => {
    expect(() => readWiring({ AW_STANDING_GRANTS: 'on' })).toThrow(/AW_STANDING_GRANTS_O04_REF/);
  });

  it('requires an integer lease', () => {
    expect(() => readWiring({ ...deliveryEnv, AW_WORKER_LEASE_MS: 'soon' })).toThrow(
      /AW_WORKER_LEASE_MS/,
    );
  });
});

describe('production gate', () => {
  it('rejects a production start whose enabled delivery config is incomplete', () => {
    const env = { ...productionBase, AW_WORKER_DELIVERY: 'on' };
    expect(() => assertStartup(env)).toThrow(ProductionStartupRejected);
    try {
      assertStartup(env);
    } catch (error) {
      const reports = (error as ProductionStartupRejected).reports;
      expect(reports.map((r) => `${r.name}=${r.status}`)).toContain('wiring-config=missing');
      expect(JSON.stringify(reports)).toContain('AW_WORKER_URL');
    }
  });

  it('accepts a production start with a complete delivery config and a real worker URL', () => {
    const reports = assertStartup({ ...productionBase, ...deliveryEnv });
    expect(reports.map((r) => `${r.name}=${r.status}`)).toEqual(
      expect.arrayContaining(['wiring-config=real', 'worker-delivery=real']),
    );
  });

  it('rejects a production worker URL on a local host', () => {
    const env = {
      ...productionBase,
      ...deliveryEnv,
      AW_WORKER_URL: 'https://localhost/internal/deliveries',
    };
    expect(() => assertStartup(env)).toThrow(/worker-delivery=local-fake/);
  });

  it('local mode still starts with the capability off and fake providers', () => {
    expect(() => assertStartup({ DATABASE_URL: 'postgres://app:app@localhost/app' })).not.toThrow();
  });
});

describe('telemetry', () => {
  it('writes JSON lines when enabled and the enforcer still denies an unpublished capability', async () => {
    const lines: string[] = [];
    const telemetry = buildTelemetry(readWiring({ AW_TELEMETRY: 'on' }), (line) =>
      lines.push(line),
    );
    expect(telemetry).toBeDefined();
    const enforcer = createSuspensionEnforcer({
      ledger: createMemorySuspensionLedger(),
      telemetry,
    });
    await expect(
      enforcer.check(
        {
          subject: 'alice',
          teams: [],
          agent: { kind: 'agent', id: 'api', version: '1' },
          skill: { kind: 'skill', id: 'ask', version: '1' },
          tool: { kind: 'tool', id: 'drive.search', version: '1' },
          model: 'gemini',
          taskId: 't1',
          traceId: 'r1',
        },
        'admission',
      ),
    ).rejects.toThrow('CAPABILITY_VERSION_UNPUBLISHED');
    expect(lines.some((line) => line.includes('suspension.decision'))).toBe(true);
  });
});

const caller = { sub: 'alice', assertion: '' };
const manifest = { id: 'skill-a', version: '1.0.0' };
function fakeSkill(run: () => Promise<void>): RegisteredSkill {
  return {
    manifest,
    validate: () => true,
    dispatch: run,
  } as unknown as RegisteredSkill;
}
function fakeAdmission(verdict: AdmissionResult) {
  const calls: string[] = [];
  const service = {
    admit: vi.fn((request: { executionId: string }) => {
      calls.push(`admit:${request.executionId}`);
      return Promise.resolve(verdict);
    }),
    release: vi.fn((id: string, outcome: string) => {
      calls.push(`release:${id}:${outcome}`);
      return Promise.resolve(outcome);
    }),
    renew: vi.fn(() => Promise.resolve(true)),
  } as unknown as AdmissionService;
  return { service, calls };
}
const policy = {
  segmentId: 'seg',
  estimatedCostMicros: 5,
  leaseMs: 30_000,
  now: () => new Date('2026-11-03T00:00:00Z'),
  teamsFor: () => Promise.resolve({ groups: ['g'] }),
};
const accepted = { taskId: 'task-1', traceId: 'trace-1' };
const dispatchArgs = [{}, accepted, { caller }, undefined] as unknown as Parameters<
  RegisteredSkill['dispatch']
>;

describe('admission wrapper', () => {
  it('admits before the skill runs and releases as succeeded', async () => {
    const { service, calls } = fakeAdmission({
      admitted: true,
      replay: false,
      expiresAt: new Date(),
    });
    const run = vi.fn(() => {
      calls.push('run');
      return Promise.resolve();
    });
    await admittedSkill(fakeSkill(run), service, policy, 'gemini').dispatch(...dispatchArgs);
    expect(calls).toEqual(['admit:task-1', 'run', 'release:task-1:succeeded']);
  });

  it('never runs the skill when admission is denied', async () => {
    const { service, calls } = fakeAdmission({ admitted: false, reason: 'member_cap' });
    const run = vi.fn(() => Promise.resolve());
    await expect(
      admittedSkill(fakeSkill(run), service, policy, 'gemini').dispatch(...dispatchArgs),
    ).rejects.toBeInstanceOf(AdmissionDenied);
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual(['admit:task-1']);
  });

  it('releases a failed run as failed and rethrows', async () => {
    const { service, calls } = fakeAdmission({
      admitted: true,
      replay: false,
      expiresAt: new Date(),
    });
    await expect(
      admittedSkill(
        fakeSkill(() => Promise.reject(new Error('boom'))),
        service,
        policy,
        'gemini',
      ).dispatch(...dispatchArgs),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['admit:task-1', 'release:task-1:failed']);
  });

  it('lets a later attempt of an already finished task continue without a second charge', async () => {
    const { service, calls } = fakeAdmission({
      admitted: false,
      reason: 'already_finished',
      state: 'succeeded',
    });
    const run = vi.fn(() => Promise.resolve());
    await admittedSkill(fakeSkill(run), service, policy, 'gemini').dispatch(...dispatchArgs);
    expect(run).toHaveBeenCalledOnce();
    expect(calls).toEqual(['admit:task-1']);
  });
});

describe('google queue client', () => {
  it('attaches the injected token and never touches the network', async () => {
    const send = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const client = createGoogleQueueHttpClient({
      accessToken: () => Promise.resolve('tok'),
      fetch: send as unknown as typeof fetch,
    });
    await expect(client.post({ url: 'https://cloudtasks.test/x', body: '{}' })).resolves.toEqual({
      status: 200,
    });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cloudtasks.test/x');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('maps a rejected envelope to a permanent publish failure and 5xx to a retryable one', async () => {
    const client = { post: vi.fn(() => Promise.resolve({ status: 503 })) };
    const publisher = buildQueuePublisher(
      readWiring({
        AW_OUTBOX_PUBLISHER: 'on',
        AW_QUEUE_PROJECT: 'proj',
        AW_QUEUE_LOCATION: 'us-central1',
        AW_QUEUE_NAME: 'dispatch',
        AW_WORKER_URL: workerUrl,
        AW_QUEUE_OIDC_SA: 'dispatcher@proj.iam.gserviceaccount.com',
        AW_OUTBOX_LEASE_MS: '30000',
      }).outbox!,
      client,
    );
    await expect(
      publisher.publish({ dispatchId: 'dsp:x', transportName: 'd-x', body: '{"bad":true}' }),
    ).rejects.toMatchObject({ retryable: false });
    const envelope = JSON.stringify({
      schemaVersion: 1,
      executionId: 'e1',
      dispatchId: 'dsp:e1',
    });
    await expect(
      publisher.publish({ dispatchId: 'dsp:e1', transportName: 'd-e1', body: envelope }),
    ).rejects.toMatchObject({ retryable: true, errorClass: 'http-503' });
    expect(client.post).toHaveBeenCalledOnce();
    expect(createOutboxQueuePublisher).toBeTypeOf('function');
  });
});

describe('delivery route', () => {
  const claims = (email: string) => ({
    iss: 'https://accounts.google.com',
    aud: workerUrl,
    sub: 'sub-1',
    email,
    email_verified: true,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  const envelope = JSON.stringify({ schemaVersion: 1, executionId: 'e1', dispatchId: 'dsp:e1' });
  async function route(email: string, outcome: 'accepted' | 'in-progress' = 'accepted') {
    const handoff = vi.fn(() => Promise.resolve(outcome));
    const routes = await createDeliveryRoutes(
      {} as postgres.Sql,
      readWiring(deliveryEnv).delivery!,
      {
        verifyIdToken: () => Promise.resolve(claims(email)),
        store: { handoff, recordRejected: () => Promise.resolve() },
      },
    );
    const handle = routes[`POST ${DELIVERY_PATH}`];
    return { handle, handoff };
  }
  const request = (authorization?: string) => ({
    method: 'POST',
    path: DELIVERY_PATH,
    headers: authorization === undefined ? {} : { authorization },
    body: Buffer.from(envelope),
  });

  it('rejects a call with no bearer before the store is reached', async () => {
    const { handle, handoff } = await route('dispatcher@proj.iam.gserviceaccount.com');
    expect((await handle(request())).status).toBe(401);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('rejects a valid token from a service account outside the allowlist', async () => {
    const { handle, handoff } = await route('intruder@proj.iam.gserviceaccount.com');
    expect((await handle(request('Bearer t'))).status).toBe(403);
    expect(handoff).not.toHaveBeenCalled();
  });

  it('acknowledges only after the durable handoff and asks for redelivery while in progress', async () => {
    const accepted = await route('dispatcher@proj.iam.gserviceaccount.com');
    expect(await accepted.handle(request('Bearer t'))).toEqual({
      status: 200,
      body: { outcome: 'accepted' },
    });
    expect(accepted.handoff).toHaveBeenCalledOnce();
    const busy = await route('dispatcher@proj.iam.gserviceaccount.com', 'in-progress');
    expect((await busy.handle(request('Bearer t'))).status).toBe(503);
  });
});

describe('background loops', () => {
  const noop = () => undefined;
  it('builds none when every flag is off', async () => {
    expect(
      await buildBackgroundLoops({
        sql: {} as postgres.Sql,
        wiring: readWiring({}),
        now: () => new Date(),
        onError: noop,
      }),
    ).toEqual([]);
  });

  it('refuses the execution worker when no handler is registered', async () => {
    await expect(
      buildBackgroundLoops({
        sql: {} as postgres.Sql,
        wiring: readWiring({ AW_EXECUTION_WORKER: 'on', AW_WORKER_LEASE_MS: '30000' }),
        now: () => new Date(),
        onError: noop,
      }),
    ).rejects.toBeInstanceOf(WiringConfigError);
  });

  it('refuses the outbox publisher without a queue', async () => {
    await expect(
      buildBackgroundLoops({
        sql: {} as postgres.Sql,
        wiring: readWiring({
          AW_OUTBOX_PUBLISHER: 'on',
          AW_QUEUE_PROJECT: 'proj',
          AW_QUEUE_LOCATION: 'us-central1',
          AW_QUEUE_NAME: 'dispatch',
          AW_WORKER_URL: workerUrl,
          AW_QUEUE_OIDC_SA: 'dispatcher@proj.iam.gserviceaccount.com',
          AW_OUTBOX_LEASE_MS: '30000',
        }),
        now: () => new Date(),
        onError: noop,
      }),
    ).rejects.toBeInstanceOf(WiringConfigError);
  });
});
