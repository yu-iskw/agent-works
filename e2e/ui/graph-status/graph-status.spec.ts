/* eslint-disable security/detect-non-literal-fs-filename -- fixed paths under the artifacts directory */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import type { Page, Route } from '@playwright/test';

// Offline DOM checks of the task graph status view: private data absent, keyboard navigation,
// out-of-order and reconnect convergence, a refused stale mutation, and axe. Run with
// `node e2e/ui/graph-status/build-harness.mjs` then `pnpm exec playwright test -c e2e/ui/graph-status/playwright.config.ts`.

const TASK = '11111111-1111-4111-8111-111111111111';
const GRAPH = `**/api/s/alpha/tasks/${TASK}/graph`;
const CANARY = 'CANARY-PRIVATE-9f3a';
const AT = '2026-11-04T10:00:00.000Z';
const shots = process.env.GRAPH_SHOTS ?? '';

type N = Record<string, unknown>;
const node = (key: string, extra: N = {}): N => ({
  key,
  title: `Step ${key}`,
  state: 'running',
  reason: null,
  dependsOn: [],
  attempt: 1,
  retryAt: null,
  approval: null,
  updatedAt: AT,
  result: null,
  ...extra,
});
const projection = (serverRevision: number, taskVersion: number, nodes: N[]) => ({
  contractVersion: 'teamwork.graph.v1',
  taskId: TASK,
  serverRevision,
  taskVersion,
  digest: 'a'.repeat(64),
  updatedAt: AT,
  nodes,
});
const reply = (route: Route, p: unknown, status = 200, extra: N = {}) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ segment: 'alpha', projection: p, taskVersion: 1, ...extra }),
  });

const built = join(__dirname, '../../../artifacts/ui/graph-harness');
let page_ = '';
let harnessJs = '';
test.beforeAll(() => {
  const css = readdirSync(built).includes('h.css')
    ? readFileSync(join(built, 'h.css'), 'utf8')
    : '';
  harnessJs = readFileSync(join(built, 'h.js'), 'utf8');
  page_ = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Graph status</title><style>${css}</style></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>`;
  if (shots) mkdirSync(shots, { recursive: true });
});

async function open(page: Page) {
  await page.route('https://harness.local/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/h.js')
      return route.fulfill({ contentType: 'text/javascript', body: harnessJs });
    return route.fulfill({ contentType: 'text/html', body: page_ });
  });
  return page;
}

const goto = async (page: Page) => {
  await page.goto('https://harness.local/');
};

test('private data is absent from the DOM, which renders only listed fields', async ({ page }) => {
  await open(page);
  // A hostile or buggy upstream adds fields; the view must not render what the contract omits.
  await page.route(GRAPH, (route) =>
    reply(route, projection(1, 1, [node('a', { brief: CANARY, output: CANARY })]), 200, {
      secret: CANARY,
    }),
  );
  await goto(page);
  await expect(page.getByText('Step a').first()).toBeVisible();
  expect(await page.content()).not.toContain(CANARY);
  await page.getByRole('button', { name: 'Table' }).click();
  expect(await page.content()).not.toContain(CANARY);
});

test('keyboard navigation moves focus along dependencies and the table is a fallback', async ({
  page,
}) => {
  await open(page);
  const nodes = [
    node('a', {
      state: 'succeeded',
      result: { href: '/s/alpha/tasks/x/results/1', label: 'Open result' },
    }),
    node('b', { state: 'running' }),
    node('c', { state: 'blocked', reason: 'prerequisite_pending', dependsOn: ['a'] }),
    node('d', {
      state: 'retry_wait',
      reason: 'retry_backoff',
      retryAt: '2026-11-04T10:05:00.000Z',
      dependsOn: ['b', 'c'],
    }),
  ];
  await page.route(GRAPH, (route) => reply(route, projection(1, 1, nodes)));
  await goto(page);
  await expect(page.locator('.gs-node')).toHaveCount(4);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focusedKey = () => page.evaluate(() => document.activeElement?.getAttribute('data-key'));
  await page.locator('.gs-node[data-key="a"]').focus();
  expect(await focusedKey()).toBe('a');
  await page.keyboard.press('ArrowDown');
  expect(await focusedKey()).toBe('b');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey()).toBe('c');
  await page.keyboard.press('ArrowRight');
  expect(await focusedKey()).toBe('d');
  await page.keyboard.press('Home');
  expect(await focusedKey()).toBe('a');
  await page.keyboard.press('End');
  expect(await focusedKey()).toBe('d');
  if (shots) await page.screenshot({ path: join(shots, 'graph.png') });

  await page.getByRole('button', { name: 'Table' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(5);
  await expect(page.getByRole('link', { name: 'Open result' })).toHaveAttribute(
    'href',
    '/s/alpha/tasks/x/results/1',
  );
  if (shots) await page.screenshot({ path: join(shots, 'table.png') });

  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations.map((v) => v.id)).toEqual([]);
});

test('out-of-order replies and a lost connection converge on the newest revision', async ({
  page,
  context,
}) => {
  await open(page);
  let calls = 0;
  await page.route(GRAPH, async (route) => {
    calls += 1;
    if (calls === 1) return reply(route, projection(2, 5, [node('a', { title: 'Revision two' })]));
    if (calls === 2) return reply(route, projection(1, 9, [node('a', { title: 'Old revision' })]));
    return reply(route, projection(3, 1, [node('a', { title: 'Revision three' })]));
  });
  await goto(page);
  await expect(page.getByText('Revision two').first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('Old revision')).toHaveCount(0);
  await expect(page.getByText('Graph revision 2')).toBeVisible();

  await context.setOffline(true);
  await page.route(GRAPH, (route) => route.abort());
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('Connection lost')).toBeVisible();
  await expect(page.getByText('Revision two').first()).toBeVisible();

  await context.setOffline(false);
  await page.unroute(GRAPH);
  await page.route(GRAPH, (route) =>
    reply(route, projection(3, 1, [node('a', { title: 'Revision three' })])),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText('Revision three').first()).toBeVisible();
  await expect(page.getByText('Connection lost')).toHaveCount(0);
});

test('a refused stale cancel shows the conflict, refreshes and is not retried', async ({
  page,
}) => {
  await open(page);
  let gets = 0;
  let posts = 0;
  await page.route(`${GRAPH}/cancel`, (route) => {
    posts += 1;
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ segment: 'alpha', error: 'stale_revision' }),
    });
  });
  await page.route(GRAPH, (route) => {
    gets += 1;
    return reply(
      route,
      projection(gets === 1 ? 1 : 2, 1, [node('a', { title: gets === 1 ? 'Before' : 'After' })]),
    );
  });
  await goto(page);
  await expect(page.getByText('Before').first()).toBeVisible();
  await page.getByRole('button', { name: 'Cancel from this view' }).click();
  await expect(page.getByRole('alert')).toContainText('nothing was done');
  await expect(page.getByText('After').first()).toBeVisible();
  expect(posts).toBe(1);
  if (shots) await page.screenshot({ path: join(shots, 'conflict.png') });
});
