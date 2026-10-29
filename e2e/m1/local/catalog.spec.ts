import { expect, test } from '@playwright/test';

import { db, ensureStarterTeam, shot, signInLocal } from '../helpers.js';

const COPY = `Evidence-first comparison (Alice ${Date.now()})`;

test('a curated skill becomes a private copy attached to two teammates; the original never changes', async ({
  page,
}) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  await page.goto('/s/alpha/catalog');
  await shot(page, '03-catalog-1440');
  await page.getByRole('link', { name: 'Evidence-first comparison', exact: true }).click();
  const curatedUrl = page.url();
  await page.getByLabel('Name').fill(COPY);
  await page
    .getByLabel('Steps (one per line)')
    .fill('List each alternative.\nQuote prices exactly.\nFlag every conflict with both values.');
  await page.getByRole('button', { name: 'Create private copy' }).click();
  await expect(page.getByText('Saved your private skill.')).toBeVisible();
  await expect(page.getByRole('heading', { name: COPY, level: 1 })).toBeVisible();
  await page.getByRole('checkbox', { name: /Research analyst/ }).check();
  await page.getByRole('checkbox', { name: /Risk and compliance reviewer/ }).check();
  await page.getByRole('button', { name: 'Save attachments' }).click();
  await expect(page.getByText('Attachments saved.')).toBeVisible();
  await shot(page, '02-skill-private-copy-1440');
  await page.goto('/s/alpha/teammates');
  await expect(
    page.locator('.tm-card', { hasText: 'Research analyst' }).getByText(`${COPY} v1`),
  ).toBeVisible();
  await expect(
    page.locator('.tm-card', { hasText: 'Risk and compliance reviewer' }).getByText(`${COPY} v1`),
  ).toBeVisible();

  await page.goto(curatedUrl);
  await expect(
    page.getByRole('heading', { name: 'Evidence-first comparison', level: 1 }),
  ).toBeVisible();
  const curated = await db('alpha')<{ n: number }[]>`
    select count(*)::int as n from tw_skill_versions v join tw_skills s on s.id = v.skill_id
    where s.origin = 'curated' and v.definition->>'name' = 'Evidence-first comparison'`;
  expect(curated[0]?.n, 'curated skill still has exactly its seeded version').toBe(1);
});

test('export contains only the definition, and import belongs to the recipient', async ({
  browser,
}) => {
  const alice = await (await browser.newContext()).newPage();
  await signInLocal(alice, 'alice@local.test');
  await ensureStarterTeam(alice, 'alpha');
  await alice.getByRole('link', { name: 'Data analyst' }).first().click();
  await alice.getByRole('link', { name: 'Export definition' }).click();
  await expect(alice.getByRole('heading', { name: 'Check the preview' })).toBeVisible();
  const json = (await alice.locator('pre.code-block').textContent()) ?? '';
  for (const forbidden of [
    'alice@local.test',
    'local-test:alice',
    'conversation',
    'sealed',
    'token',
    'fixture-alpha',
  ])
    expect(json.toLowerCase(), forbidden).not.toContain(forbidden);
  await shot(alice, '04-export-preview-1440');

  const bob = await (await browser.newContext()).newPage();
  await signInLocal(bob, 'bob@local.test');
  await bob.goto('/s/alpha/import');
  await bob.getByLabel('Definition (JSON)').fill(json);
  await bob.getByRole('button', { name: 'Import' }).click();
  await expect(bob.getByRole('heading', { name: /Imported Data analyst/ })).toBeVisible();
  const owners = await db('alpha')<
    { owner_sub: string }[]
  >`select owner_sub from tw_teammates where origin = 'imported' order by created_at desc limit 1`;
  expect(owners[0]?.owner_sub).toBe('local-test:bob');

  await bob.goto('/s/alpha/import');
  await bob.getByLabel('Definition (JSON)').fill(
    JSON.stringify({
      ...JSON.parse(json),
      connections: [{ provider: 'google', account: 'alice@local.test' }],
    }),
  );
  await bob.getByRole('button', { name: 'Import' }).click();
  await expect(bob.getByText('That is not a valid teammate definition file.')).toBeVisible();
});
