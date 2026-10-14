import { randomUUID } from 'node:crypto';

import { suspensionHistorySchema } from '@agent-works/domain';
import { expect, test, vi } from 'vitest';

import { createScriptedRunner } from '../agent/scripted-runner.js';
import { createApp } from '../app.js';
import { createMemoryAuditLog } from '../audit/write.js';
import { createListener } from '../http.js';
import { createMemorySuspensionLedger } from '../ports/memory/suspension-ledger.js';
import { publishBundledCapabilities } from '../suspension/bootstrap.js';
import { createSuspensionEnforcer } from '../suspension/enforcement.js';
import { listenerFetch } from '../suspension/http-test-harness.js';
import {
  bundledVersionBaseline,
  controlledListener,
  controlledVerify,
} from '../suspension/runtime.js';
import { suspendCommand, scopeTargets, testAt } from '../suspension/test-fixtures.js';

import { adminChangeRoutes } from './admin-change.js';
import { adminReadRoutes } from './admin-read.js';

import type { Caller } from '../auth/iap.js';
import type { Drive } from '../retrieval/drive-port.js';

test('real HTTP listener admin API lists, stops, audits and preserves role boundary', async () => {
  const ledger = createMemorySuspensionLedger();
  const deps = {
    ledger,
    now: () => testAt,
    verify: () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller),
    rolesFor: () => Promise.resolve(['Admin' as const]),
  };
  const fetch = listenerFetch(
    createListener({ ...adminReadRoutes(deps), ...adminChangeRoutes(deps) }),
  );
  const url = 'http://127.0.0.1:8084';
  try {
    const command = suspendCommand(scopeTargets[0]);
    const response = await fetch(`${url}/v1/admin/suspensions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command.command),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ record: { suspended: true, actorSub: 'alice' } });
    expect(await (await fetch(`${url}/v1/admin/suspensions`)).json()).toMatchObject({
      suspensions: [{ suspended: true }],
      versions: [],
    });
    expect(await (await fetch(`${url}/v1/admin/history`)).json()).toMatchObject({
      events: [{ eventType: 'admin.suspend' }],
    });
    const oversized = await fetch(`${url}/v1/admin/suspensions`, {
      method: 'POST',
      body: 'x'.repeat(20_000),
    });
    expect(oversized.status).toBe(413);
    expect(await ledger.history()).toHaveLength(1);
  } finally {
    /* No kernel socket to release. */
  }
});

test('production-style app wiring stops admissions, retains admin recovery and resumes model calls', async () => {
  const control = createMemorySuspensionLedger();
  const manifest = {
    id: 'incident',
    version: '1',
    state: 'PUBLISHED' as const,
    tools: ['ticket.create'],
  };
  await publishBundledCapabilities(control, bundledVersionBaseline(manifest));
  const enforcer = createSuspensionEnforcer({ ledger: control, now: () => testAt });
  const verify = controlledVerify(
    () => Promise.resolve({ sub: 'alice', assertion: 'verified' } as Caller),
    () => Promise.resolve({ groups: ['engineering', 'agent-admins@company.example'] }),
    enforcer,
  );
  const model = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      candidates: [
        { content: { parts: [{ text: 'Grounded runbook answer' }] }, finishReason: 'STOP' },
      ],
    }),
  );
  const drive = vi
    .fn<Drive['retrieve']>()
    .mockResolvedValue([
      { id: 'runbook', title: 'runbook', text: 'triage', uri: 'https://drive.fake.test/runbook' },
    ]);
  const app = createApp({
    verify,
    admin: { ledger: control, rolesFor: () => Promise.resolve(['Admin']), now: () => testAt },
    drive: { retrieve: drive },
    runner: createScriptedRunner({ baseUrl: 'http://localhost', fetch: model }),
    audit: createMemoryAuditLog(),
    now: () => testAt,
  });
  const fetch = listenerFetch(controlledListener(app, enforcer));
  const stop = suspendCommand(scopeTargets[0]);
  expect(
    (
      await fetch('http://localhost/v1/admin/suspensions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(stop.command),
      })
    ).status,
  ).toBe(200);
  expect((await fetch('http://localhost/healthz')).status).toBe(200);
  const ask = () =>
    fetch('http://localhost/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), question: 'triage' }),
    });
  expect((await ask()).status).toBe(503);
  expect(model).not.toHaveBeenCalled();
  expect(drive).not.toHaveBeenCalled();
  const history = await fetch('http://localhost/v1/admin/history');
  expect(history.status).toBe(200);
  const historyPayload = suspensionHistorySchema.parse(await history.json());
  expect(historyPayload.events.slice(-2).map((event) => event.eventType)).toEqual([
    'admin.suspend',
    'invocation.denied',
  ]);

  const resume = {
    ...stop.command,
    commandId: randomUUID(),
    action: 'resume',
    expectedRevision: 1,
  };
  expect(
    (
      await fetch('http://localhost/v1/admin/suspensions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resume),
      })
    ).status,
  ).toBe(200);
  expect((await ask()).status).toBe(200);
  expect(model).toHaveBeenCalledOnce();
  expect(drive).toHaveBeenCalledOnce();
  expect(
    (await control.history()).filter((event) => event.eventType === 'admin.suspend'),
  ).toHaveLength(1);
  expect(
    (await control.history()).filter((event) => event.eventType === 'admin.resume'),
  ).toHaveLength(1);
});
