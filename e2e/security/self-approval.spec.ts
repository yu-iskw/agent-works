import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import type { Caller } from '../../apps/api/src/auth/iap.js';
import type * as Store from '../../apps/api/src/broker/approvals.js';
import type * as Broker from '../../apps/api/src/broker/broker.js';
import type * as ApprovalsRoute from '../../apps/api/src/routes/approvals.js';
import type * as Domain from '../../packages/domain/src/index.js';

const digest = 'a'.repeat(64);

function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}

test('sec.self-approval', async ({ page }) => {
  const domain = await load<typeof Domain>('packages/domain/dist/index.js');
  const storeMod = await load<typeof Store>('apps/api/dist/broker/approvals.js');
  const brokerMod = await load<typeof Broker>('apps/api/dist/broker/broker.js');
  const routes = await load<typeof ApprovalsRoute>('apps/api/dist/routes/approvals.js');
  const store = storeMod.createMemoryApprovalStore();
  await store.save(
    domain.approvalSchema.parse({
      id: 'apr-1',
      taskId: 'tsk-1',
      stepId: 'step-1',
      tool: brokerMod.TICKET_TOOL,
      targetResource: 'PROJ',
      payloadSha256: digest,
      requestedBySub: 'alice',
      approverSub: null,
      state: 'pending',
      expiresAt: '2026-12-01T00:00:00.000Z',
      maxExecutions: 1,
      executionsUsed: 0,
    }),
  );
  const route = routes.createApprovalsRoute({
    store,
    verify: (assertion) => {
      const sub = assertion ?? 'missing';
      return Promise.resolve({ sub, assertion: sub } as Caller);
    },
    rolesFor: () => Promise.resolve(['Reviewer']),
  });
  const reply = await route({
    method: 'POST',
    path: '/v1/approvals/apr-1:decide',
    headers: {
      [domain.IAP_ASSERTION_HEADER]: 'alice',
      'x-csrf-token': 'token-1',
    },
    body: Buffer.from(
      JSON.stringify({
        kind: 'decide',
        decision: 'approve',
        expectedPayloadSha256: digest,
      }),
    ),
  });
  expect(reply).toEqual({ status: 403, body: { error: 'self_approval' } });
  const stored = await store.read('apr-1');
  expect(stored).toMatchObject({ state: 'pending', approverSub: null });
  if (stored === undefined) throw new Error('approval missing');
  const error =
    typeof reply.body === 'object' &&
    reply.body !== null &&
    'error' in reply.body &&
    typeof reply.body.error === 'string'
      ? reply.body.error
      : '';
  await page.setContent(
    `<main><p>${escapeHtml(error)}</p><p>${escapeHtml(stored.state)}</p></main>`,
  );
  await expect(page.getByText(error)).toBeVisible();
  await expect(page.getByText(stored.state)).toBeVisible();
});

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
