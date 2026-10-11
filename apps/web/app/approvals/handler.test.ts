import { createServer } from 'node:http';

import { expect, test } from 'vitest';

import { createApprovalsHandler } from './handler.js';

import type { Approval } from '@agent-works/domain';

const approval: Approval = {
  id: 'apr-1',
  taskId: 'tsk-1',
  stepId: 'step-1',
  tool: 'tickets.create',
  targetResource: '<script>alert(1)</script>',
  payloadSha256: 'a'.repeat(64),
  requestedBySub: 'alice',
  approverSub: null,
  state: 'pending',
  expiresAt: '2099-12-01T00:00:00.000Z',
  maxExecutions: 1,
  executionsUsed: 0,
};

async function world(load: typeof fetch, value: Approval = approval) {
  const server = createServer(
    createApprovalsHandler({
      apiUrl: 'http://127.0.0.1:9',
      readApproval: (id) => Promise.resolve(id === value.id ? value : undefined),
      fetch: load,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  const url = `http://127.0.0.1:${address.port}/approvals/apr-1`;
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
  const csrfToken = cookie.split('=')[1];
  return {
    page,
    url,
    cookie,
    form: new URLSearchParams({
      csrfToken,
      decision: 'approve',
      expectedPayloadSha256: approval.payloadSha256,
    }),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

test.each(['missing-cookie', 'wrong-token', 'foreign-origin'])(
  'blocks %s before calling the API',
  async (scenario) => {
    let calls = 0;
    const app = await world(() => {
      calls += 1;
      return Promise.resolve(Response.json({}));
    });
    try {
      if (scenario === 'wrong-token') app.form.set('csrfToken', 'b'.repeat(64));
      const result = await fetch(`${app.url}/decide`, {
        method: 'POST',
        headers: {
          cookie: scenario === 'missing-cookie' ? '' : app.cookie,
          ...(scenario === 'foreign-origin' ? { origin: 'https://foreign.test' } : {}),
        },
        body: app.form,
      });
      expect(result.status).toBe(403);
      expect(calls).toBe(0);
    } finally {
      await app.close();
    }
  },
);

test.each(['network', 'invalid-json', 'wrong-id'])(
  'does not show success for %s',
  async (scenario) => {
    const app = await world(() => {
      if (scenario === 'network') return Promise.reject(new Error('offline'));
      if (scenario === 'invalid-json') return Promise.resolve(new Response('broken'));
      return Promise.resolve(
        Response.json({ kind: 'decided', id: 'other', state: 'approved', executionsUsed: 0 }),
      );
    });
    try {
      const result = await fetch(`${app.url}/decide`, {
        method: 'POST',
        headers: { cookie: app.cookie },
        body: app.form,
      });
      expect(result.status).toBe(scenario === 'wrong-id' ? 502 : 503);
      const html = await result.text();
      expect(html).toContain('role="alert"');
      expect(html).toContain('Reload approval');
      expect(html).not.toContain('Approval approved.');
      expect(html).not.toContain('<button');
    } finally {
      await app.close();
    }
  },
);

test('escapes action details and hides decisions for expired approvals', async () => {
  const app = await world(() => Promise.reject(new Error('unused')), {
    ...approval,
    expiresAt: '2020-01-01T00:00:00.000Z',
  });
  try {
    const html = await app.page.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('This approval has expired.');
    expect(html).not.toContain('<button');
    expect((await fetch(app.url.replace('apr-1', 'missing'))).status).toBe(404);
  } finally {
    await app.close();
  }
});
