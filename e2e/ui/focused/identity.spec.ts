import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { endsWith, signInLocal, signOut } from '../helpers.js';

import type { Page } from '@playwright/test';

// Identity editing, preferences and startup views. Identity is private to the member's teammate:
// the template and the instructions never change, capabilities stay what the policy computes,
// and bob's copy of the same template is untouched. Themes apply with no flash on reload because
// the server stamps the chosen theme on the first response. No model is called.

const ALICE = 'local-test:alice';

async function ensureStarterTeam(page: Page): Promise<void> {
  await page.goto('/s/alpha/teammates');
  const add = page.getByRole('button', { name: /starter team/i });
  if (await add.isVisible()) await add.click();
}

type TeammateRow = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  template_version: number;
  version: number;
};

async function firstTeammate(): Promise<TeammateRow> {
  const [row] = await db('alpha')<TeammateRow[]>`
    select id, name, role, instructions, template_version, version from tw_teammates
    where owner_sub = ${ALICE} and not archived order by created_at limit 1`;
  return row;
}

async function openDetails(page: Page, teammateId: string): Promise<void> {
  await page.goto(`/s/alpha/teammates/${teammateId}`);
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Teammate details' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Display name' })).toBeVisible();
}

test.describe('identity editor', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    await ensureStarterTeam(page);
  });

  test('saves avatar, name, role label and accent privately, without touching behaviour', async ({
    page,
  }) => {
    const before = await firstTeammate();
    const [templateBefore] = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from tw_template_versions`;
    await openDetails(page, before.id);
    const capsBefore = await page
      .getByRole('list', { name: 'Effective capabilities' })
      .allTextContents()
      .catch(() => []);

    const stamp = `Haru ${Date.now() % 10_000}`;
    await page.getByRole('textbox', { name: 'Display name' }).fill(stamp);
    await page.getByRole('textbox', { name: 'Role label' }).fill('Research lead');
    await page
      .getByRole('radiogroup', { name: 'Avatar' })
      .getByRole('radio', { name: 'Moon' })
      .check();
    await page
      .getByRole('radiogroup', { name: 'Accent color' })
      .getByRole('radio', { name: 'Coral' })
      .check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.form-msg')).toHaveText('Saved.');

    // The same identity everywhere: header, sidebar row and the panel preview.
    await expect(page.getByRole('heading', { level: 1 })).toContainText(stamp);
    await expect(page.locator('.hd-role')).toHaveText('Research lead');
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const row = page
      .getByRole('list', { name: 'Teammates' })
      .getByRole('listitem')
      .filter({ hasText: stamp });
    await expect(row).toHaveCount(1);
    await expect(row.locator('.avatar')).toHaveAttribute('data-accent', 'coral');
    await expect(row.locator('.avatar')).toHaveAttribute('data-avatar', 'moon');
    await expect(page.locator('.hd-who .avatar')).toHaveAttribute('data-avatar', 'moon');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(stamp);

    const after = await firstTeammate();
    expect(after.name).toBe(stamp);
    expect(after.instructions).toBe(before.instructions);
    expect(after.template_version).toBe(before.template_version);
    expect(after.version).toBe(before.version + 1);
    const [templateAfter] = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from tw_template_versions`;
    expect(templateAfter.n).toBe(templateBefore.n);
    const capsAfter = await page
      .getByRole('list', { name: 'Effective capabilities' })
      .allTextContents()
      .catch(() => []);
    expect(capsAfter).toEqual(capsBefore);
  });

  test('a stale save is refused and the editor reloads the current version', async ({ page }) => {
    const teammate = await firstTeammate();
    await openDetails(page, teammate.id);
    await db(
      'alpha',
    )`update tw_teammates set version = version + 1, updated_at = now() where id = ${teammate.id}`;
    await page.getByRole('textbox', { name: 'Role label' }).fill('Conflicting label');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('.form-msg')).toContainText('changed elsewhere');
    const after = await firstTeammate();
    expect(after.role).not.toBe('Conflicting label');
  });

  test('attaches and detaches a skill on this teammate only', async ({ page }) => {
    const teammate = await firstTeammate();
    await openDetails(page, teammate.id);
    await page.locator('details.attach summary').click();
    const option = page.getByRole('list', { name: 'Available skills' }).getByRole('button').first();
    const name = (await option.locator('.row-title').textContent()) ?? '';
    expect(name).not.toBe('');
    await option.click();
    await expect(page.locator('.form-msg')).toHaveText(`Attached ${name}.`);
    const chips = page.getByRole('list', { name: 'Attached skills' });
    await expect(chips).toContainText(name);
    const rows = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from tw_teammate_skills where teammate_id = ${teammate.id}`;
    expect(rows[0].n).toBeGreaterThan(0);
    await chips.getByRole('button', { name: `Detach ${name}` }).click();
    await expect(page.locator('.form-msg')).toHaveText(`Detached ${name}.`);
    await expect(chips).not.toContainText(name);
  });
});

test.describe('preferences and startup', () => {
  test.beforeEach(async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    await ensureStarterTeam(page);
  });

  test('theme persists per member and the first response already carries it', async ({ page }) => {
    const teammate = await firstTeammate();
    await page.goto(`/s/alpha/teammates/${teammate.id}`);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Preferences' })).toBeVisible();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const html = await (await page.request.get(`/s/alpha/teammates/${teammate.id}`)).text();
    expect(html.startsWith('<!doctype html><html lang="en" data-theme="dark">')).toBe(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'System' }).check();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  });

  test('startup choices land on the inbox, the recap, or the last conversation', async ({
    page,
  }) => {
    const teammate = await firstTeammate();
    await page.goto(`/s/alpha/teammates/${teammate.id}`);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: /Attention inbox/ }).check();
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(/\/teammates\/[0-9a-f-]+\/inbox$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Attention inbox' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveCount(1);

    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: /Coordinator recap/ }).check();
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(/\/teammates\/[0-9a-f-]+\/recap$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Coordinator recap' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs your decision' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Running work' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Recent results' })).toBeVisible();
    await expect(page.getByText('No model was called.')).toBeVisible();

    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: /Last conversation/ }).check();
    await page.goto('/s/alpha');
    await expect(page).toHaveURL(endsWith(`/teammates/${teammate.id}`));
  });

  test('bob gets his own teammate and preferences, not alice’s', async ({ page }) => {
    const alice = await firstTeammate();
    await page.goto(`/s/alpha/teammates/${alice.id}`);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await signOut(page);
    await signInLocal(page, 'bob@local.test');
    await page.goto('/s/alpha/teammates');
    const add = page.getByRole('button', { name: /starter team/i });
    if (await add.isVisible()) await add.click();
    await page.goto('/s/alpha');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    await expect(page.getByText('bob@local.test')).toBeVisible();
    await page.getByRole('tab', { name: 'Teammates' }).click();
    await expect(page.getByRole('list', { name: 'Teammates' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Teammates' })).not.toContainText(alice.name);
    const response = await page.request.get(`/s/alpha/teammates/${alice.id}`);
    expect(response.status()).toBe(404);
  });
});
