import { readFileSync } from 'node:fs';

import { expect } from '@playwright/test';
import postgres from 'postgres';

import type { BrowserContext, Page } from '@playwright/test';

const SCREENSHOTS = 'artifacts/m1/screenshots';

const pools = new Map<string, postgres.Sql>();

/** Direct read access to a segment database, for backend invariants the UI cannot show. */
export function db(segment: 'alpha' | 'beta' | 'web'): postgres.Sql {
  let sql = pools.get(segment);
  if (sql === undefined) {
    sql = postgres(`postgres://postgres@pg-${segment}:5432/postgres`, {
      onnotice: () => undefined,
      max: 2,
    });
    pools.set(segment, sql);
  }
  return sql;
}

export async function signInLocal(
  page: Page,
  email: 'alice@local.test' | 'bob@local.test' = 'alice@local.test',
): Promise<void> {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: `Continue as ${email}` }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
}

/**
 * A real member session for browser tests: web re-verifies the member with Google through their
 * stored refresh token (see docs/m1/SETUP_OAUTH.md). The secret file is mounted only into e2e.
 */
export async function signInLive(context: BrowserContext, email: string): Promise<void> {
  const secret = readFileSync('/run/aw-m1/e2e-session.secret', 'utf8').trim();
  const response = await fetch(
    `${process.env.M1_INTERNAL_URL ?? 'http://web:8081'}/internal/e2e/session`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-e2e-secret': secret },
      body: JSON.stringify({ email }),
    },
  );
  const body = (await response.json()) as {
    cookie?: { name: string; value: string };
    idp?: string;
    error?: string;
  };
  if (!response.ok || body.cookie === undefined)
    throw new Error(
      `live sign-in refused for a member: ${body.error ?? response.status}. Sign in once in the host browser (docs/m1/SETUP_OAUTH.md section 4).`,
    );
  expect(body.idp).toBe('google');
  await context.addCookies([
    {
      name: body.cookie.name,
      value: body.cookie.value,
      domain: 'web',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

export async function ensureStarterTeam(page: Page, segment: string): Promise<void> {
  await page.goto(`/s/${segment}/teammates`);
  const starter = page.getByRole('button', { name: 'Add the starter team' });
  if (await starter.isVisible()) {
    await starter.click();
    await expect(page.getByRole('link', { name: 'Coordinator' })).toBeVisible();
  }
}

export async function teammateId(page: Page, segment: string, name: string): Promise<string> {
  await page.goto(`/s/${segment}/teammates`);
  const href = await page.getByRole('link', { name, exact: true }).first().getAttribute('href');
  const id = /\/teammates\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
  if (id === undefined) throw new Error(`no teammate named ${name}`);
  return id;
}

export function taskIdFrom(page: Page): string {
  const id = /\/tasks\/([0-9a-f-]{36})/.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`not on a task page: ${page.url()}`);
  return id;
}

/** Waits on the task's backend status through the same version endpoint the page polls. */
export async function waitForStatus(
  page: Page,
  segment: string,
  taskId: string,
  statuses: readonly string[],
  timeoutMs = 300_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await page.request.get(`/s/${segment}/tasks/${taskId}/version`);
    const state = (await response.json()) as { status?: string };
    if (state.status !== undefined && statuses.includes(state.status)) return state.status;
    if (Date.now() > deadline)
      throw new Error(`task stayed ${state.status ?? 'unknown'}; wanted ${statuses.join('|')}`);
    await page.waitForTimeout(1500);
  }
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOTS}/${name}.png`, fullPage: true });
}
