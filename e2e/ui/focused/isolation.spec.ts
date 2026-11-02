import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import {
  apiPost,
  coordinator,
  csrfToken,
  seedResultTask,
  seedUnreadReply,
  signInLocal,
  signOut,
} from '../helpers.js';

import type { Locator, Page } from '@playwright/test';

// Member, segment and origin boundaries as a browser sees them: what one member leaves behind on
// a shared browser, what a segment switch may paint, what a direct request gets, what a forged
// POST gets, and what untrusted text can do. No model is called.

const message = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const chips = (page: Page): Locator => page.getByRole('group', { name: 'Context' });

async function attach(page: Page, name: string, body: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await page.getByRole('button', { name: 'Add to the message' }).click();
      await page.getByRole('option', { name: /Attach a file/ }).click();
    })(),
  ]);
  await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(body, 'utf8') });
  await expect(page.locator('.cx-ready')).toHaveCount(1);
}

const workspaceKeys = (page: Page): Promise<string[]> =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('aw:')));

test.describe('member boundary on one browser', () => {
  test('bob sees none of alice: draft, file chip, conversation, preferences or storage keys', async ({
    page,
  }) => {
    await signInLocal(page, 'alice@local.test');
    const owner = await coordinator('alpha');
    await page.goto(`/s/alpha/teammates/${owner.id}`);
    const secret = `alice draft ${Date.now()} not for bob`;
    await message(page).fill(secret);
    await attach(page, 'alice-private-notes.txt', 'alice line 1');
    await expect(chips(page)).toContainText('alice-private-notes.txt');
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Close panel' }).click();
    await expect.poll(() => workspaceKeys(page)).not.toEqual([]);
    const aliceTags = new Set((await workspaceKeys(page)).map((k) => k.split(':')[1]));
    expect(aliceTags.size).toBe(1);
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const aliceTeammates = await page
      .getByRole('list', { name: 'Teammates' })
      .getByRole('listitem')
      .allInnerTexts();
    expect(aliceTeammates.join(' ')).toContain('Coordinator');

    await signOut(page);
    expect(await workspaceKeys(page), 'sign-out clears the drafts').toEqual([]);
    await signInLocal(page, 'bob@local.test');
    await page.goto('/s/alpha/teammates');
    const add = page.getByRole('button', { name: /starter team/i });
    if (await add.isVisible()) await add.click();
    await page.goto('/s/alpha');
    await expect(message(page)).toBeVisible();
    await expect(message(page)).toHaveValue('');
    await expect(chips(page)).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
    await expect(page.locator('.who-mail')).toHaveText('bob@local.test');
    await expect(page.locator('.who-mail')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(secret);
    await expect(page.locator('body')).not.toContainText('alice-private-notes.txt');
    await page.getByRole('tab', { name: 'Teammates' }).click();
    const bobTeammates = page.getByRole('list', { name: 'Teammates' });
    await expect(bobTeammates).toBeVisible();
    await expect(bobTeammates).not.toContainText('Coordinator');
    for (const key of await workspaceKeys(page))
      expect(aliceTags.has(key.split(':')[1] ?? ''), `${key} is not alice's`).toBe(false);
    // Bob's own draft lands under his tag only.
    await message(page).fill('bob draft');
    await expect.poll(() => workspaceKeys(page)).not.toEqual([]);
    for (const key of await workspaceKeys(page))
      expect(aliceTags.has(key.split(':')[1] ?? ''), key).toBe(false);
  });

  test('a draft typed in alpha never appears in beta', async ({ page }) => {
    await signInLocal(page, 'alice@local.test');
    const alpha = await coordinator('alpha');
    await page.goto(`/s/alpha/teammates/${alpha.id}`);
    const draft = `alpha only ${Date.now()}`;
    await message(page).fill(draft);
    await expect.poll(() => workspaceKeys(page).then((k) => k.join(' '))).toContain(':alpha:');
    await page.goto('/s/beta');
    await expect(message(page)).toBeVisible();
    await expect(page.locator('.hd-seg')).toContainText('Beta Health');
    await expect(message(page)).toHaveValue('');
    await page.goto(`/s/alpha/teammates/${alpha.id}`);
    await expect(message(page)).toHaveValue(draft);
  });
});

test.describe('segment boundary', () => {
  test('a slow alpha conversation never paints in beta, and a cross-segment reply is dropped', async ({
    page,
  }) => {
    await signInLocal(page, 'alice@local.test');
    const alpha = await coordinator('alpha');
    const marker = `alpha reply ${Date.now()} must stay in alpha`;
    await seedUnreadReply(alpha.conversationId, marker);
    let delayed = 0;
    await page.route(`**/api/s/alpha/conversations/${alpha.conversationId}**`, async (route) => {
      delayed += 1;
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });
    await page.goto(`/s/alpha/teammates/${alpha.id}`);
    await expect(message(page)).toBeVisible();
    await expect.poll(() => delayed, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Beta Health' }).click();
    await expect(page.locator('.hd-seg')).toContainText('Beta Health');
    await expect(message(page)).toBeVisible();
    await page.waitForTimeout(4000);
    await expect(page.locator('body')).not.toContainText(marker);
    await expect(page.locator('.hd-seg')).toContainText('Beta Health');
    await page.unroute(`**/api/s/alpha/conversations/${alpha.conversationId}**`);

    // A reply stamped with another segment is refused by the client before it reaches the store.
    const alphaPage = await page.request.get(
      `/api/s/alpha/conversations/${alpha.conversationId}?teammate=${alpha.id}`,
    );
    const alphaBody = (await alphaPage.json()) as { segment: string };
    expect(alphaBody.segment).toBe('alpha');
    const beta = await coordinator('beta');
    let served = 0;
    await page.route(`**/api/s/beta/conversations/${beta.conversationId}**`, async (route) => {
      served += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...alphaBody,
          id: beta.conversationId,
          teammateId: beta.id,
        }),
      });
    });
    await page.goto(`/s/beta/teammates/${beta.id}`);
    await expect(message(page)).toBeVisible();
    await expect.poll(() => served, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await expect(page.locator('body')).not.toContainText(marker);
    await expect(page.locator('.hd-seg')).toContainText('Beta Health');
  });

  test('direct requests for another member’s task, attachment and conversation are not found', async ({
    browser,
  }) => {
    const alice = await (await browser.newContext()).newPage();
    await signInLocal(alice, 'alice@local.test');
    const owner = await coordinator('alpha');
    const task = await seedResultTask('alpha', '');
    await alice.goto(`/s/alpha/teammates/${owner.id}`);
    await attach(alice, 'alice-evidence.txt', 'private evidence');
    const [attachment] = await db('alpha')<{ id: string }[]>`
      select id from tw_attachments where owner_sub = 'local-test:alice' and name = 'alice-evidence.txt'
      order by created_at desc limit 1`;
    if (attachment === undefined) throw new Error('the upload left no attachment row');
    const paths = [
      `/api/s/alpha/tasks/${task.taskId}`,
      `/api/s/alpha/attachments/${attachment.id}`,
      `/api/s/alpha/conversations/${owner.conversationId}?teammate=${owner.id}`,
      `/api/s/alpha/teammates/${owner.id}`,
      `/s/alpha/teammates/${owner.id}`,
      `/s/alpha/tasks/${task.taskId}`,
      `/s/alpha/teammates/${owner.id}/export.json`,
    ];
    for (const path of paths) expect((await alice.request.get(path)).status(), path).toBe(200);

    const bob = await (await browser.newContext()).newPage();
    await signInLocal(bob, 'bob@local.test');
    for (const path of paths) expect((await bob.request.get(path)).status(), path).toBe(404);
    // With bob's own session token and origin, ownership is the only thing that refuses.
    await bob.goto('/s/alpha');
    await expect(message(bob)).toBeVisible();
    const command = await apiPost(bob, `/api/s/alpha/tasks/${task.taskId}/publish`, {
      revision: 1,
    });
    expect(`${command.status()} ${await command.text()}`).toMatch(/^404 /);
    const [approvals] = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from wb_approvals where task_id = ${task.taskId}`;
    expect(approvals?.n).toBe(0);
  });
});

test.describe('forged requests', () => {
  test('JSON POSTs without the session token, with a wrong token, or from a foreign origin are refused and write nothing', async ({
    page,
  }) => {
    await signInLocal(page, 'alice@local.test');
    const owner = await coordinator('alpha');
    await page.goto(`/s/alpha/teammates/${owner.id}`);
    const origin = new URL(page.url()).origin;
    const token = await csrfToken(page);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const path = `/api/s/alpha/conversations/${owner.conversationId}/messages`;
    const forgedText = `forged ${Date.now()}`;
    const count = async () =>
      (
        await db('alpha')<{ n: number }[]>`
          select count(*)::int as n from tw_messages
          where conversation_id = ${owner.conversationId} and role = 'member' and body = ${forgedText}`
      )[0]?.n ?? 0;
    const body = { clientRequestId: '00000000-0000-4000-8000-00000000c5f0', text: forgedText };
    const attempts: readonly [string, Record<string, string>][] = [
      ['no token', { origin }],
      ['wrong token', { origin, 'x-csrf-token': 'f'.repeat(64) }],
      ['foreign origin', { origin: 'https://evil.example', 'x-csrf-token': token }],
      ['no origin at all', { 'x-csrf-token': token }],
      ['form content type', { origin, 'x-csrf-token': token, 'content-type': 'text/plain' }],
    ];
    for (const [name, headers] of attempts) {
      const response = await page.request.post(path, {
        headers: { 'content-type': 'application/json', ...headers },
        data: body,
      });
      expect(response.status(), name).toBe(403);
      expect(((await response.json()) as { error: string }).error, name).toBe('csrf');
    }
    const task = await seedResultTask('alpha', '');
    const publish = await page.request.post(`/api/s/alpha/tasks/${task.taskId}/publish`, {
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      data: { revision: 1 },
    });
    expect(publish.status()).toBe(403);
    expect(await count(), 'no message row was written').toBe(0);
    const [approvals] = await db('alpha')<{ n: number }[]>`
      select count(*)::int as n from wb_approvals where task_id = ${task.taskId}`;
    expect(approvals?.n).toBe(0);
  });
});

test.describe('untrusted text', () => {
  const PAYLOADS = [
    '<script>window.__xss = 1; alert("script")</script>',
    '<img src=x onerror="window.__xss = 2; alert(\'img\')">',
    '[click me](javascript:alert("link"))',
    '<a href="javascript:alert(1)">anchor</a>',
    '![x](x) <svg onload=alert(1)>',
  ];

  test('messages, file names and model output render as inert text', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await signInLocal(page, 'alice@local.test');
    const owner = await coordinator('alpha');
    for (const payload of PAYLOADS) await seedUnreadReply(owner.conversationId, payload);
    const result = await seedResultTask('alpha', PAYLOADS.join(' '));
    await page.goto(`/s/alpha/teammates/${owner.id}`);
    const timeline = page.locator('.tl');
    await expect(timeline).toContainText('<script>window.__xss = 1');
    await expect(timeline).toContainText('onerror=');
    await expect(timeline).toContainText('[click me](javascript:alert("link"))');
    await attach(page, '<img src=x onerror=alert(3)>.txt', 'a file with a hostile name');
    await expect(chips(page)).toContainText('<img src=x onerror=alert(3)>.txt');

    await page.goto(`/s/alpha/teammates/${owner.id}/tasks/${result.taskId}/results/1`);
    const panel = page.locator('.pn-body');
    await expect(panel).toContainText('<script>window.__xss = 1');
    await expect(panel).toContainText('javascript:alert("link")');

    const inert = await page.evaluate(() => ({
      scripts: [...document.querySelectorAll('script')].filter(
        (s) => s.type !== 'application/json' && !s.src.includes('/assets/'),
      ).length,
      images: document.querySelectorAll('img[src="x"], svg[onload]').length,
      javascriptLinks: [...document.querySelectorAll('a')].filter((a) =>
        a.getAttribute('href')?.toLowerCase().startsWith('javascript:'),
      ).length,
      handlers: document.querySelectorAll('[onerror], [onload], [onclick]').length,
      marker: (window as unknown as { __xss?: number }).__xss ?? null,
    }));
    expect(inert).toEqual({ scripts: 0, images: 0, javascriptLinks: 0, handlers: 0, marker: null });
    expect(dialogs).toEqual([]);
  });
});

test.describe('export privacy', () => {
  test('a teammate export carries the definition only: no files, drafts, messages or preferences', async ({
    page,
  }) => {
    await signInLocal(page, 'alice@local.test');
    const owner = await coordinator('alpha');
    await page.goto(`/s/alpha/teammates/${owner.id}`);
    const draft = `unsent draft ${Date.now()}`;
    await message(page).fill(draft);
    await attach(page, 'export-probe.txt', 'export probe file body');
    const reply = `teammate reply ${Date.now()} for the export probe`;
    await seedUnreadReply(owner.conversationId, reply);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'Dark' }).check();
    await page.getByRole('button', { name: 'Close panel' }).click();

    const response = await page.request.get(`/s/alpha/teammates/${owner.id}/export.json`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    const exported = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(exported).sort()).toEqual(
      [
        'capabilityRequests',
        'format',
        'instructions',
        'kind',
        'name',
        'parameters',
        'role',
        'skills',
      ].sort(),
    );
    expect(exported.kind).toBe('teammate');
    for (const leak of [
      draft,
      reply,
      'export-probe',
      'export probe file body',
      'dark',
      'theme',
      'alice@local.test',
      owner.conversationId,
    ])
      expect(text, `export does not carry ${leak}`).not.toContain(leak);
    await page.getByRole('button', { name: 'Preferences' }).click();
    await page.getByRole('radio', { name: 'System' }).check();
  });
});
