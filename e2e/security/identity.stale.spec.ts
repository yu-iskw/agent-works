import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

import { expect, test } from '@playwright/test';

const seededObservedAt = '2026-01-01T00:00:00.000Z';
const seededObservedMs = Date.parse(seededObservedAt);
const oneDayMs = 86_400_000;
const snapshot = {
  sub: 'bob',
  groups: ['agent-users@company.example'],
  observedAt: seededObservedAt,
};
const repoRoot = process.cwd();

let directoryUrl = '';
let closeDirectory: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/snapshots/bob') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(snapshot));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('port');
  directoryUrl = `http://127.0.0.1:${address.port}`;
  closeDirectory = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

test.afterAll(async () => {
  await closeDirectory?.();
});

function rolesAt(nowMs?: number): Promise<readonly string[]> {
  const clock = nowMs === undefined ? '' : `now: () => ${nowMs},`;
  const script = `
    import { createRoleResolver } from './apps/api/src/auth/directory.ts';
    const roles = await createRoleResolver({
      baseUrl: ${JSON.stringify(directoryUrl)},
      ${clock}
    })('bob');
    process.stdout.write(JSON.stringify(roles));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { cwd: repoRoot },
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
        reject(new Error(stderr || 'role resolver failed'));
        return;
      }
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed) || !parsed.every((role) => typeof role === 'string')) {
        reject(new Error('role resolver returned an unexpected value'));
        return;
      }
      resolve(parsed);
    });
  });
}

test('sec.stale-groups', async ({ page }) => {
  await page.goto(`${directoryUrl}/snapshots/bob`);
  await expect(page.locator('body')).toContainText('agent-users@company.example');
  const body: unknown = await (await page.request.get(`${directoryUrl}/snapshots/bob`)).json();
  expect(body).toEqual(snapshot);

  const rolesAtObservation = await rolesAt(seededObservedMs);
  expect(rolesAtObservation).toEqual(['Employee']);

  const rolesOneDayLater = await rolesAt(seededObservedMs + oneDayMs);
  expect(rolesOneDayLater).toEqual([]);

  const rolesNow = await rolesAt();
  expect(rolesNow).toEqual([]);

  await page.evaluate(
    (evidence) => {
      const pre = document.createElement('pre');
      pre.textContent = evidence;
      document.body.replaceChildren(pre);
    },
    JSON.stringify({ snapshot, rolesAtObservation, rolesOneDayLater, rolesNow }, null, 2),
  );
});
