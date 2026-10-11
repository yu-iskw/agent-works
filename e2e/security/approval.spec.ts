import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import type * as Approvals from '../../apps/api/src/broker/approvals.js';
import type * as Broker from '../../apps/api/src/broker/broker.js';
import type * as Ledger from '../../apps/api/src/ports/memory/ledger-port.js';
import type * as Domain from '../../packages/domain/src/index.js';
import type * as Fakes from '../../packages/fakes/src/index.js';
import type * as Policy from '../../packages/policy/src/index.js';

const now = new Date('2026-10-11T12:00:00.000Z');
const payload = { summary: 'Ship the fix', project: 'PROJ' };

const facts = {
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
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function codeOf(result: { ok: true } | { ok: false; code: string }): string {
  return result.ok ? 'ok' : result.code;
}

function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}

async function stack() {
  const domain = await load<typeof Domain>('packages/domain/dist/index.js');
  const policy = await load<typeof Policy>('packages/policy/dist/index.js');
  const fakes = await load<typeof Fakes>('packages/fakes/dist/index.js');
  const ledger = await load<typeof Ledger>('apps/api/dist/ports/memory/ledger-port.js');
  const approvals = await load<typeof Approvals>('apps/api/dist/broker/approvals.js');
  const brokerMod = await load<typeof Broker>('apps/api/dist/broker/broker.js');
  const server = await fakes.listen(fakes.createTicket(), 0);
  const store = approvals.createMemoryApprovalStore();
  let posts = 0;
  const broker = brokerMod.createBroker({
    store,
    decide: policy.decide,
    ledger: ledger.createMemoryLedgerPort(() => now),
    approverAuthorized: () => true,
    now: () => now,
    async postTicket(body, idempotencyKey) {
      posts += 1;
      const response = await fetch(`${server.url}/tickets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      const parsed: unknown = await response.json();
      if (typeof parsed !== 'object' || parsed === null || !('receipt' in parsed)) {
        throw new Error('ticket receipt missing');
      }
      if (typeof parsed.receipt !== 'string') throw new Error('ticket receipt missing');
      return parsed.receipt;
    },
  });
  const digest = domain.canonicalPayloadSha256(payload);
  return {
    posts: () => posts,
    async tickets() {
      const response = await fetch(`${server.url}/tickets`);
      const parsed: unknown = await response.json();
      if (typeof parsed !== 'object' || parsed === null || !('tickets' in parsed)) return 0;
      return Array.isArray(parsed.tickets) ? parsed.tickets.length : 0;
    },
    async grant() {
      await store.save({
        id: 'apr-1',
        taskId: 'tsk-1',
        stepId: 'step-1',
        tool: brokerMod.TICKET_TOOL,
        targetResource: 'PROJ',
        payloadSha256: digest,
        requestedBySub: 'alice',
        approverSub: 'bob',
        state: 'approved',
        expiresAt: '2026-12-01T00:00:00.000Z',
        maxExecutions: 1,
        executionsUsed: 0,
      });
    },
    execute(patch: Partial<Broker.ExecuteInput> = {}): ReturnType<Broker.Broker['execute']> {
      return broker.execute({
        id: 'call-1',
        taskId: 'tsk-1',
        stepId: 'step-1',
        toolRef: brokerMod.TICKET_TOOL,
        idempotencyKey: 'key-1',
        targetResource: 'PROJ',
        payload,
        approvalId: 'apr-1',
        actorSub: 'alice',
        traceId: 'trace-1',
        facts,
        ...patch,
      });
    },
    close: () => server.close(),
  };
}

test('sec.approval-replay', async ({ page }) => {
  const world = await stack();
  try {
    await world.grant();
    const first = await world.execute();
    const second = await world.execute();
    expect(first).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(second).toEqual({ ok: true, receipt: 'FAKE-1', replay: true });
    expect(world.posts()).toBe(1);
    const tickets = await world.tickets();
    expect(tickets).toBe(1);
    if (!first.ok) throw new Error('replay');
    await page.setContent(
      `<main><p>${escapeHtml(first.receipt)}</p><p>tickets ${tickets}</p></main>`,
    );
    await expect(page.getByText(first.receipt)).toBeVisible();
    await expect(page.getByText(`tickets ${tickets}`)).toBeVisible();
  } finally {
    await world.close();
  }
});

test('sec.approval-mutation', async ({ page }) => {
  const world = await stack();
  try {
    await world.grant();
    const summary = await world.execute({
      id: 'call-summary',
      idempotencyKey: 'key-summary',
      payload: { summary: 'Changed summary', project: 'PROJ' },
    });
    const target = await world.execute({
      id: 'call-target',
      idempotencyKey: 'key-target',
      targetResource: 'OTHER',
    });
    const tool = await world.execute({
      id: 'call-tool',
      idempotencyKey: 'key-tool',
      toolRef: 'ticket.delete@1.0.0',
    });
    expect(world.posts()).toBe(0);
    expect(await world.tickets()).toBe(0);
    const summaryCode = codeOf(summary);
    const targetCode = codeOf(target);
    const toolCode = codeOf(tool);
    expect(summaryCode).toBe('APPROVAL_REQUIRED');
    expect(targetCode).toBe('APPROVAL_REQUIRED');
    expect(toolCode).toBe('APPROVAL_REQUIRED');
    await page.setContent(
      `<main><p>summary ${escapeHtml(summaryCode)}</p><p>target ${escapeHtml(targetCode)}</p><p>tool ${escapeHtml(toolCode)}</p></main>`,
    );
    await expect(page.getByText(`summary ${summaryCode}`)).toBeVisible();
    await expect(page.getByText(`target ${targetCode}`)).toBeVisible();
    await expect(page.getByText(`tool ${toolCode}`)).toBeVisible();
  } finally {
    await world.close();
  }
});

test('broker.duplicate-call-id', async ({ page }) => {
  const world = await stack();
  try {
    await world.grant();
    const first = await world.execute();
    const second = await world.execute({ idempotencyKey: 'key-2' });
    expect(first).toEqual({ ok: true, receipt: 'FAKE-1', replay: false });
    expect(world.posts()).toBe(1);
    const tickets = await world.tickets();
    expect(tickets).toBe(1);
    if (second.ok) throw new Error('duplicate call');
    expect(second.status).toBe(409);
    expect(second.code).toBe('DUPLICATE_CALL');
    await page.setContent(
      `<main><p>${second.status}</p><p>${escapeHtml(second.code)}</p><p>tickets ${tickets}</p></main>`,
    );
    await expect(page.getByText(String(second.status), { exact: true })).toBeVisible();
    await expect(page.getByText(second.code)).toBeVisible();
  } finally {
    await world.close();
  }
});
