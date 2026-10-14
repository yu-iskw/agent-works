import { createServer } from 'node:http';

import { canonicalPayloadSha256 } from '@agent-works/domain';
import { test, expect } from '@playwright/test';

import { createWorkspaceApprovalsHandler } from './workspace-handler.js';
import smokeConfig from './workspace-playwright.config.js';

test.setTimeout(smokeConfig.timeout ?? 30_000);
test('workspace approval shows exact payload, then approves through CSRF form', async ({
  page,
}) => {
  const destinationId = 'alice-folder';
  const payload = {
    title: 'Meeting prep',
    destinationId,
    body: '<script>bad</script>Agenda',
  };
  const approval = {
    id: 'approval-1',
    taskId: 'task-1',
    stepId: 'docs',
    tool: 'docs.createDraft@1.0.0',
    targetResource: destinationId,
    payloadSha256: canonicalPayloadSha256(payload),
    requestedBySub: 'alice',
    approverSub: null,
    state: 'pending',
    expiresAt: '2027-01-01T00:00:00Z',
    maxExecutions: 1,
    executionsUsed: 0,
  };
  const load: typeof fetch = (input) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    return Promise.resolve(
      Response.json(
        path.endsWith('/decide')
          ? { id: approval.id, state: 'approved', executionsUsed: 0 }
          : { approval, payload },
      ),
    );
  };
  const server = createServer(
    createWorkspaceApprovalsHandler({
      apiUrl: 'http://127.0.0.1:8084',
      fetch: load,
      now: () => new Date('2026-10-14T10:00:00Z'),
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('port');
    await page.goto(`http://127.0.0.1:${address.port}/approvals/workspace/approval-1`);
    await expect(page.getByRole('heading', { name: 'Review workspace approval' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Workspace payload changes' })).toContainText(
      'alice-folder',
    );
    await expect(page.getByRole('table', { name: 'Workspace payload changes' })).toContainText(
      '<script>bad</script>Agenda',
    );
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Decision saved.');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
