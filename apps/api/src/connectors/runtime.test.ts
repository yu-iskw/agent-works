import { expect, it } from 'vitest';

import { workspaceScopes } from '../../../../packages/domain/dist/workspace-tools.js';
import { createGoogleCalendar } from '../../../../packages/fakes/dist/google-calendar.js';
import { createGoogleDocs } from '../../../../packages/fakes/dist/google-docs.js';
import { createGoogleGmail } from '../../../../packages/fakes/dist/google-gmail.js';
import { googleFakeTransport } from '../../../../packages/fakes/dist/google-transport.js';
import { createMemoryApprovalStore } from '../broker/approvals.js';

import { createWorkspaceRuntime } from './runtime.js';
import { connection, fixtureNow, workspaceCall } from './test-fixtures.js';

import type { Caller } from '../auth/iap.js';
import type { OAuthFlow } from '../credentials/flow.js';
it('assembles an offline runtime with routes, adapters, broker and meeting-prep skill', async () => {
  const tokens = new Map([['token', { subject: 'alice', scopes: Object.values(workspaceScopes) }]]);
  const docs = createGoogleDocs({ tokens, destinations: new Map([['alice-folder', ['alice']]]) });
  const calendar = createGoogleCalendar({ tokens });
  const gmail = createGoogleGmail({ tokens });
  const endpoint = (handler: Parameters<typeof googleFakeTransport>[0]) => ({
    baseUrl: 'http://127.0.0.1',
    fetch: googleFakeTransport(handler),
    sleep: () => Promise.resolve(),
  });
  const credentials = {
    read: () => Promise.resolve(connection()),
    save: (value: ReturnType<typeof connection>) => Promise.resolve(value),
  };
  const runtime = createWorkspaceRuntime({
    endpoints: {
      docs: endpoint(docs.handler),
      calendar: endpoint(calendar.handler),
      gmail: endpoint(gmail.handler),
    },
    credentials: {
      credentials,
      provider: {
        read: () => Promise.resolve(connection()),
        exchange: () => Promise.resolve(connection()),
        revoke: () => Promise.resolve(connection()),
        authorizationUrl: () => 'http://127.0.0.1/authorize',
      },
      resolveToken: () => Promise.resolve('token'),
      now: () => fixtureNow,
      audit: () => Promise.resolve(),
    },
    broker: {
      approvals: createMemoryApprovalStore(),
      now: () => fixtureNow,
      authorize: () =>
        Promise.resolve({ allowed: true, ceiling: 'CONFIDENTIAL', decisionId: 'd1' }),
      approverAuthorized: () => true,
      audit: () => Promise.resolve(),
    },
    routes: {
      verify: () => Promise.resolve({ sub: 'alice' } as Caller),
      flow: {} as OAuthFlow,
      authorizePreparation: () => Promise.resolve(true),
    },
    meeting: { driveSearch: () => Promise.resolve([]), draft: () => Promise.resolve('Brief') },
  });
  expect(runtime.skill.manifest.id).toBe('meeting-prep');
  expect(Object.keys(runtime.routes)).toContain('POST /v1/connectors/execute');
  await expect(runtime.broker.execute(workspaceCall({ tool: 'gmail.send' }))).rejects.toMatchObject(
    { code: 'POLICY_DENIED' },
  );
  expect(docs.documents()).toEqual([]);
});
