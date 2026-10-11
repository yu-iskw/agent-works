import { execFileSync, spawn } from 'node:child_process';

import { expect, test } from '@playwright/test';

const canary = 'canary-do-not-log';

test.beforeAll(() => {
  execFileSync('pnpm', ['--filter', '@agent-works/api...', 'build'], {
    cwd: process.cwd(),
    stdio: 'pipe',
  });
});

test('sec.token-canary', async ({ page }) => {
  const report = await runCanary();
  expect(report.stored).toEqual({
    provider: 'fake',
    subject: 'alice',
    scope: 'ticket.create',
    status: 'active',
    expiresAt: '2099-01-01T00:00:00.000Z',
    tokenRef: 'token-1',
  });
  expect(report.revoked).toEqual({ ...report.stored, status: 'revoked' });
  expect(report.blockedStatus).toBe('BLOCKED_AUTH');
  expect(report.providerToken).toBe(canary);
  expect(JSON.stringify(report.stored).includes(canary)).toBe(false);
  expect(JSON.stringify(report.event).includes(canary)).toBe(false);
  const visible = {
    stored: report.stored,
    revoked: report.revoked,
    blockedStatus: report.blockedStatus,
    event: report.event,
  };
  await page.setContent(
    `<main><pre>${JSON.stringify(visible)}</pre><p>canary-in-store=false</p></main>`,
  );
  await expect(page.getByText('canary-in-store=false')).toBeVisible();
  expect(await page.locator('main').innerText()).not.toContain(canary);
});

type CanaryReport = {
  readonly stored: {
    readonly provider: string;
    readonly subject: string;
    readonly scope: string;
    readonly status: string;
    readonly expiresAt: string;
    readonly tokenRef: string;
  };
  readonly revoked: CanaryReport['stored'];
  readonly blockedStatus: string;
  readonly event: unknown;
  readonly providerToken: string;
};

function runCanary(): Promise<CanaryReport> {
  const script = `
    import { createHash } from 'node:crypto';
    import { oauthStartSchema, taskSchema, transition } from './packages/domain/dist/index.js';
    import { createOAuth } from './packages/fakes/src/fake-oauth.ts';
    import { listen } from './packages/fakes/src/http.ts';
    import { createMemoryCredentialsPort } from './apps/api/dist/ports/memory/credentials.js';
    import { createOAuthFlow } from './apps/api/dist/credentials/flow.js';
    import { createHttpOAuthProvider } from './apps/api/dist/credentials/provider.js';

    const verifier = 'verifier-value-which-is-long-enough';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const grants = new Map();
    const credentials = createMemoryCredentialsPort();
    let task = taskSchema.parse({
      id: 'task-1',
      createdBySub: 'alice',
      status: 'RUNNING',
      objectiveDigest: 'digest',
      skillVersion: 'ask',
      agentVersion: 'test',
      policyVersion: 'test',
      budget: 0.1,
      version: 1,
      createdAt: '2026-10-10T00:00:00.000Z',
      updatedAt: '2026-10-10T00:00:00.000Z',
    });
    let event;
    let instant = new Date('2026-10-10T00:00:00.000Z');
    const server = await listen(createOAuth(), 0);
    try {
      const flow = createOAuthFlow({
        credentials,
        grants: {
          save(grant) { grants.set(grant.state, grant); return Promise.resolve(); },
          read(state) { return Promise.resolve(grants.get(state)); },
          consume(state) {
            const grant = grants.get(state);
            grants.delete(state);
            return Promise.resolve(grant);
          },
        },
        provider: createHttpOAuthProvider(server.url),
        ledger: {
          read(subject, taskId) {
            if (task.id !== taskId || task.createdBySub !== subject) return Promise.resolve(undefined);
            return Promise.resolve(task);
          },
          transition(input) {
            const next = transition(task, input.to);
            task = { ...next, updatedAt: input.event.event.occurredAt };
            event = input.event;
            return Promise.resolve(task);
          },
        },
        now: () => instant,
      });
      const start = oauthStartSchema.parse({
        provider: 'fake',
        state: 'state-1',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        scope: 'ticket.create',
      });
      await flow.begin('alice', start);
      const authorized = await fetch(server.url + '/oauth/authorize', {
        method: 'POST',
        body: JSON.stringify({ subject: 'alice', ...start }),
      });
      const authorizedBody = await authorized.json();
      const stored = await flow.complete('alice', {
        provider: 'fake',
        state: 'state-1',
        code: authorizedBody.code,
        codeVerifier: verifier,
      });
      const revoked = await flow.revoke('alice', 'fake');
      const proofStart = oauthStartSchema.parse({ ...start, state: 'state-2' });
      const proofCode = await fetch(server.url + '/oauth/authorize', {
        method: 'POST',
        body: JSON.stringify({ subject: 'alice', ...proofStart }),
      });
      const proofBody = await proofCode.json();
      const proofToken = await fetch(server.url + '/oauth/token', {
        method: 'POST',
        body: JSON.stringify({
          provider: 'fake',
          state: 'state-2',
          code: proofBody.code,
          codeVerifier: verifier,
        }),
      });
      const proof = await proofToken.json();
      instant = new Date('2100-01-01T00:00:00.000Z');
      const blocked = await flow.blockIfStale('alice', 'fake', 'task-1');
      process.stdout.write(JSON.stringify({
        stored,
        revoked,
        blockedStatus: blocked.status,
        event,
        providerToken: proof.token,
      }));
    } finally {
      await server.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        script,
      ],
      { cwd: process.cwd() },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      if (status !== 0) {
        reject(new Error(stderr || 'token canary failed'));
        return;
      }
      const parsed: unknown = JSON.parse(stdout);
      if (!isReport(parsed)) {
        reject(new Error('token canary returned an unexpected value'));
        return;
      }
      resolve(parsed);
    });
  });
}

function isReport(value: unknown): value is CanaryReport {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'stored' in value &&
    'revoked' in value &&
    'blockedStatus' in value &&
    'event' in value &&
    'providerToken' in value &&
    typeof value.blockedStatus === 'string' &&
    typeof value.providerToken === 'string'
  );
}
