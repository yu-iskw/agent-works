import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import type * as Approvals from '../../apps/api/src/broker/approvals.js';
import type * as Ports from '../../apps/api/src/ports/memory/task-ports.js';
import type * as Incident from '../../apps/api/src/skills/incident.js';
import type * as Registry from '../../apps/api/src/skills/registry.js';
import type * as Dispatcher from '../../apps/api/src/skills/task-dispatcher.js';
import type * as Stack from '../../apps/api/src/testing/stack.js';
import type * as Authorization from '../../apps/api/src/testing/task-authorization.js';
import type * as Domain from '../../packages/domain/src/index.js';
import type * as Fakes from '../../packages/fakes/src/index.js';

function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}

// Use the shipped incident adapter, never a test adapter that secretly inserts a broker.
test('incident.end-to-end', async ({ page }, info) => {
  test.setTimeout(70_000);
  const approvalsModule = await load<typeof Approvals>('apps/api/dist/broker/approvals.js');
  const approvals = approvalsModule.createMemoryApprovalStore();
  const portsModule = await load<typeof Ports>('apps/api/dist/ports/memory/task-ports.js');
  const incidentModule = await load<typeof Incident>('apps/api/dist/skills/incident.js');
  const registryModule = await load<typeof Registry>('apps/api/dist/skills/registry.js');
  const dispatcherModule = await load<typeof Dispatcher>('apps/api/dist/skills/task-dispatcher.js');
  const stackModule = await load<typeof Stack>('apps/api/dist/testing/stack.js');
  const authorization = await load<typeof Authorization>(
    'apps/api/dist/testing/task-authorization.js',
  );
  const domain = await load<typeof Domain>('packages/domain/dist/index.js');
  const fakes = await load<typeof Fakes>('packages/fakes/dist/index.js');
  const ports = portsModule.createMemoryTaskPorts();
  const incidents = await fakes.listen(fakes.createIncidents(), 0);
  let posts = 0;
  const ticketHandler = fakes.createTicket();
  const tickets = await fakes.listen((request) => {
    if (request.method === 'POST') posts += 1;
    return ticketHandler(request);
  }, 0);
  let release = () => {};
  const modelGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const payload = { summary: 'Checkout latency rose after deploy dep-9.', project: 'incidents' };
  const skill = incidentModule.createIncidentSkill(() => ({
    incidentsUrl: incidents.url,
    ticketsUrl: tickets.url,
    model: {
      answer: async () => {
        await modelGate;
        return payload.summary;
      },
    },
  }));
  const registry = registryModule.createSkillRegistry([skill]);
  const worker = dispatcherModule.createTaskDispatcher({ ...ports, registry, maxAttempts: 1 });
  const priorTasks = process.env.AW_TASKS;
  const priorRead = process.env.AW_TASKS_READ;
  const priorEvents = process.env.AW_TASKS_EVENTS;
  process.env.AW_TASKS = 'real';
  process.env.AW_TASKS_READ = 'real';
  process.env.AW_TASKS_EVENTS = 'real';
  const stack = await stackModule.startStack({
    skills: registry,
    dispatch: ports.dispatch,
    approvals: { store: approvals, rolesFor: () => Promise.resolve(['Reviewer']) },
    wire: {
      ...authorization.taskAuthorization.wire,
      ledger: ports.ledger,
      search: { search: () => Promise.resolve([]) },
    },
  });
  let running: Promise<boolean> | undefined;
  try {
    const started = performance.now();
    const key = randomUUID();
    const submit = () =>
      fetch(`${stack.iapUrl}/v1/tasks`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-fake-user': 'alice',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          kind: 'submit',
          objective: 'Analyze checkout incident',
          skillId: 'incident-analysis',
          input: { incidentId: 'inc-1', approvalId: 'incident-approval' },
          sourceAllowlist: ['incidents'],
          requestedOutputs: ['ticket'],
          executionPolicy: { mode: 'interactive', budgetUsd: 1, deadlineSeconds: 60 },
        }),
      });
    const response = await submit();
    expect(response.status).toBe(200);
    const accepted = domain.taskApiSchema.parse(await response.json());
    if (!('kind' in accepted) || accepted.kind !== 'accepted') throw new Error('task not accepted');
    const acceptanceMs = performance.now() - started;
    expect(acceptanceMs).toBeLessThan(3000);
    expect(await ports.ledger.read('alice', accepted.taskId)).toMatchObject({
      id: accepted.taskId,
      status: 'QUEUED',
      createdBySub: 'alice',
    });
    expect(posts).toBe(0);
    await approvals.save({
      id: 'incident-approval',
      taskId: accepted.taskId,
      stepId: 'ticket',
      tool: 'ticket.create@1.0.0',
      targetResource: 'incidents',
      payloadSha256: domain.canonicalPayloadSha256(payload),
      requestedBySub: 'alice',
      approverSub: null,
      state: 'pending',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      maxExecutions: 1,
      executionsUsed: 0,
    });
    expect(
      await approvals.bind('incident-approval', {
        actorSub: 'bob',
        decision: 'approve',
        expectedPayloadSha256: domain.canonicalPayloadSha256(payload),
      }),
    ).toMatchObject({ ok: true });
    running = worker.runOnce();
    expect(await domain.taskApiSchema.parseAsync(await (await submit()).json())).toEqual(accepted);
    release();
    expect(await running).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    const task = await ports.ledger.read('alice', accepted.taskId);
    expect(task).toMatchObject({ status: 'COMPLETED', createdBySub: 'alice', version: 3 });
    const receipt = await ports.ledger.readReceipt('alice', accepted.taskId);
    expect(receipt).toEqual({
      ref: 'FAKE-1',
      digestSha256: domain.canonicalPayloadSha256(payload),
    });
    expect(posts).toBe(1);
    const external = await (await fetch(`${tickets.url}/tickets`)).json();
    expect(external).toEqual({
      tickets: [{ id: 'FAKE-1', ...payload, idempotencyKey: accepted.taskId }],
    });
    const events = await ports.ledger.events('alice', accepted.taskId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            eventType: 'task.completed',
            externalObjectRef: 'FAKE-1',
          }),
        }),
      ]),
    );
    const completionMs = performance.now() - started;
    const evidence = {
      acceptanceMs,
      completionMs,
      targetMs: 60_000,
      provider: 'FAKE',
      task,
      receipt,
      events,
      external,
      payloadDigest: domain.canonicalPayloadSha256(payload),
    };
    console.info(
      `incident.end-to-end: acceptance ${acceptanceMs.toFixed(1)} ms, completion ${completionMs.toFixed(1)} ms (local target 60000 ms)`,
    );
    await info.attach('metrics.json', {
      body: JSON.stringify({ durationsMs: [completionMs], p95Ms: completionMs }),
      contentType: 'application/json',
    });
    const evidencePath = info.outputPath('incident-evidence.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Playwright allocates this test artifact path
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await info.attach('incident-evidence.json', {
      path: evidencePath,
      contentType: 'application/json',
    });
    const observed = JSON.stringify(evidence, null, 2);
    await page.setContent(
      '<main><h1>Incident delivery observed results</h1><pre style="white-space: pre-wrap"></pre></main>',
    );
    await page.locator('pre').evaluate((element, text) => {
      element.textContent = text;
    }, observed);
    await expect(page.locator('pre')).toHaveText(observed);
    expect(completionMs).toBeLessThanOrEqual(60_000);
    // The shipped adapter must bind the approved payload and record broker provenance.
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            eventType: 'tool.intended',
            initiatorSubject: 'alice',
            agentPrincipal: 'agent:broker',
            approvalId: expect.any(String),
            policyDecisionId: expect.any(String),
            requestDigestSha256: domain.canonicalPayloadSha256(payload),
          }),
        }),
      ]),
    );
  } finally {
    release();
    await running;
    await worker.stop();
    await stack.close();
    await tickets.close();
    await incidents.close();
    if (priorTasks === undefined) delete process.env.AW_TASKS;
    else process.env.AW_TASKS = priorTasks;
    if (priorRead === undefined) delete process.env.AW_TASKS_READ;
    else process.env.AW_TASKS_READ = priorRead;
    if (priorEvents === undefined) delete process.env.AW_TASKS_EVENTS;
    else process.env.AW_TASKS_EVENTS = priorEvents;
  }
});
