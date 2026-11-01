import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import { signInLocal, signOut } from '../helpers.js';

import type { Locator, Page } from '@playwright/test';

// Composer menus, chips, member files, send keys, double-submit and member isolation. Tests that
// post a message or start a task carry `@model` in their title: the segment answers each with a
// real model call, so the coordinator budgets them. Everything else is non-generative.

const message = (page: Page): Locator => page.getByRole('textbox', { name: 'Message' });
const plus = (page: Page): Locator => page.getByRole('button', { name: 'Add to the message' });
const uuid = () => crypto.randomUUID();

async function openConversation(page: Page): Promise<void> {
  await signInLocal(page, 'alice@local.test');
  await page.goto('/s/alpha/teammates');
  const starter = page.getByRole('button', { name: /starter team/i });
  if (await starter.isVisible()) await starter.click();
  await page.goto('/s/alpha');
  await expect(message(page)).toBeVisible();
}

/** Types a trigger character and returns the listbox that opens for it. */
async function openTrigger(page: Page, key: '@' | '/'): Promise<Locator> {
  await message(page).click();
  await page.keyboard.type(key);
  const list = page.getByRole('listbox');
  await expect(list).toBeVisible();
  return list;
}

async function attach(
  page: Page,
  name: string,
  body: string,
  mimeType = 'text/plain',
): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    (async () => {
      await plus(page).click();
      await page.getByRole('option', { name: /Attach a file/ }).click();
    })(),
  ]);
  await chooser.setFiles({ name, mimeType, buffer: Buffer.from(body, 'utf8') });
}

/** The attachment ids the composer currently holds as ready chips, read from the segment DB by name. */
async function attachmentIds(names: readonly string[]): Promise<string[]> {
  const rows = await db('alpha')<{ id: string; name: string }[]>`
    select id, name from tw_attachments
    where owner_sub = 'local-test:alice' and removed_at is null and name = any(${[...names]})
    order by created_at desc`;
  return names.map((name) => rows.find((row) => row.name === name)?.id ?? 'missing');
}

test.describe('menus', () => {
  test('+ opens a listbox with real actions, works by keyboard, and returns focus', async ({
    page,
  }) => {
    await openConversation(page);
    await plus(page).focus();
    await page.keyboard.press('Enter');
    const list = page.getByRole('listbox', { name: 'Add to the message' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveText([
      /Attach a file/,
      /Add source/,
      /Create task/,
      /Ask the coordinator for a plan/,
    ]);
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(plus(page)).toBeFocused();
    await plus(page).click();
    await expect(list).toBeVisible();
    await page.mouse.click(10, 10);
    await page.keyboard.press('Escape');
  });

  test('@ at a word boundary lists teammates with roles and sources with reasons; Escape returns to the textarea', async ({
    page,
  }) => {
    await openConversation(page);
    const list = await openTrigger(page, '@');
    await expect(list.getByRole('group', { name: 'Teammates' })).toBeVisible();
    await expect(list.getByRole('group', { name: 'Sources' })).toBeVisible();
    const disabled = list
      .getByRole('option')
      .filter({ has: page.locator('[aria-disabled="true"]') });
    if ((await disabled.count()) > 0) await expect(disabled.first()).toContainText(/Needs /);
    await page.keyboard.type('zzzz-no-such-teammate');
    await expect(list).toContainText('No teammates or sources match.');
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(message(page)).toBeFocused();
    await message(page).fill('mail me at alice@local');
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  test('/ at a line start lists attached skills and only the commands with a target', async ({
    page,
  }) => {
    await openConversation(page);
    const teammateId = page.url().split('/teammates/')[1]?.split(/[/?]/)[0] ?? '';
    // /ask needs a linked task to ask about; /answer needs one that waits for an answer.
    const [{ linked, openQuestions }] = await db('alpha')<
      { linked: number; openQuestions: number }[]
    >`
      select count(*)::int as linked,
             count(*) filter (where t.status = 'needs_input')::int as "openQuestions"
      from wb_tasks t
      join tw_conversations c on c.id = t.conversation_id
      where c.teammate_id = ${teammateId}`;
    const list = await openTrigger(page, '/');
    await expect(list.getByRole('option', { name: '/task' })).toBeVisible();
    await expect(list.getByRole('option', { name: '/plan' })).toBeVisible();
    await expect(list.getByRole('option', { name: '/ask' })).toHaveCount(linked > 0 ? 1 : 0);
    if (openQuestions === 0)
      await expect(list.getByRole('option', { name: '/answer' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await message(page).fill('not at start /');
    await expect(page.getByRole('listbox')).toBeHidden();
  });

  test('Enter picks the active @ teammate as a chip and removes the trigger text', async ({
    page,
  }) => {
    await openConversation(page);
    await openTrigger(page, '@');
    await page.keyboard.press('Enter');
    const chips = page.getByRole('group', { name: 'Context' });
    await expect(chips.getByRole('button', { name: /^Remove / })).toHaveCount(1);
    await expect(message(page)).toHaveValue('');
    await expect(message(page)).toBeFocused();
    await expect(page.getByText(/make this a task/)).toBeVisible();
  });
});

test.describe('chips', () => {
  test('chips are removable by pointer and keyboard, and Backspace at the start focuses the last chip', async ({
    page,
  }) => {
    await openConversation(page);
    await openTrigger(page, '@');
    await page.keyboard.press('Enter');
    const remove = page.getByRole('button', { name: /^Remove / });
    await expect(remove).toHaveCount(1);
    await message(page).focus();
    await page.keyboard.press('Backspace');
    await expect(remove.first()).toBeFocused();
    await page.keyboard.press('Delete');
    await expect(remove).toHaveCount(0);
    await expect(message(page)).toBeFocused();
    await page.reload();
    await expect(page.getByRole('group', { name: 'Context' })).toHaveCount(0);
  });

  test('chips and text persist across a reload and never leak to another member on the same browser', async ({
    page,
  }) => {
    await openConversation(page);
    await message(page).fill('draft for alice');
    await attach(page, 'alice-notes.txt', 'alice line 1\nalice line 2');
    await expect(page.getByRole('group', { name: 'Context' })).toContainText('alice-notes.txt');
    await expect(page.locator('.cx-ready')).toHaveCount(1);
    await page.reload();
    await expect(message(page)).toHaveValue('draft for alice');
    await expect(page.getByRole('group', { name: 'Context' })).toContainText('alice-notes.txt');
    await signOut(page);
    await signInLocal(page, 'bob@local.test');
    await page.goto('/s/alpha');
    await expect(message(page)).toBeVisible();
    await expect(message(page)).toHaveValue('');
    await expect(page.getByRole('group', { name: 'Context' })).toHaveCount(0);
    const keys = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('aw:')),
    );
    expect(keys.every((k) => !k.includes('draft') || k.split(':').length === 5)).toBe(true);
    const tags = new Set(keys.map((k) => k.split(':')[1]));
    expect(tags.size).toBeLessThanOrEqual(1);
  });
});

test.describe('files', () => {
  test('a supported file uploads, previews with provenance, and removal removes it before send', async ({
    page,
  }) => {
    await openConversation(page);
    await attach(page, 'facts.md', '# Facts\n\n- one\n- two\n');
    const chip = page
      .getByRole('group', { name: 'Context' })
      .locator('.cx-main', { hasText: 'facts.md' });
    await expect(page.locator('.cx-ready')).toHaveCount(1);
    await chip.click();
    const preview = page.getByRole('dialog', { name: 'Preview of facts.md' });
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('# Facts');
    await expect(preview).toContainText(/uploaded by you · sha256 [0-9a-f]{12}/);
    await page.keyboard.press('Escape');
    await expect(preview).toBeHidden();
    await expect(chip).toBeFocused();
    const [id] = await attachmentIds(['facts.md']);
    expect(id).not.toBe('missing');
    await page.getByRole('button', { name: 'Remove facts.md' }).click();
    await expect
      .poll(async () => {
        const rows = await db('alpha')<{ removed: boolean }[]>`
        select removed_at is not null as removed from tw_attachments where id = ${id}`;
        return rows[0]?.removed;
      })
      .toBe(true);
  });

  test('unsupported and oversize files are refused with a useful message and the draft survives', async ({
    page,
  }) => {
    await openConversation(page);
    await message(page).fill('keep this text');
    await attach(page, 'report.pdf', '%PDF-1.4 fake', 'application/pdf');
    await expect(page.getByRole('alert')).toContainText(
      'PDF is not supported yet; paste the text or upload .txt, .md, .csv or .json.',
    );
    await expect(message(page)).toHaveValue('keep this text');
    await expect(page.getByRole('group', { name: 'Context' })).toHaveCount(0);
    await attach(page, 'big.txt', 'x'.repeat(201 * 1024));
    await expect(page.getByRole('alert')).toContainText('the limit is 200 KB per file');
    await expect(message(page)).toHaveValue('keep this text');
    await attach(page, 'bad.json', '{not json');
    await expect(page.locator('.cx-failed')).toHaveCount(1);
    await expect(page.locator('.cx-failed').getByRole('alert')).toContainText('not valid JSON');
    await expect(
      page.getByRole('group', { name: 'Context' }).getByRole('button', { name: 'Retry' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Remove bad.json' }).click();
    await expect(message(page)).toHaveValue('keep this text');
  });

  test('@model a sent message carries exactly the selected attachment ids and not a removed one', async ({
    page,
  }) => {
    await openConversation(page);
    await attach(page, 'keep.txt', 'kept text');
    await attach(page, 'drop.txt', 'dropped text');
    await expect(page.locator('.cx-ready')).toHaveCount(2);
    const [keepId, dropId] = await attachmentIds(['keep.txt', 'drop.txt']);
    await page.getByRole('button', { name: 'Remove drop.txt' }).click();
    const text = `files ${uuid()}`;
    await message(page).fill(text);
    await message(page).press('Enter');
    await expect
      .poll(async () => {
        const rows = await db('alpha')<{ attachment_ids: string[] }[]>`
        select attachment_ids from tw_messages where role = 'member' and body = ${text}`;
        return rows[0]?.attachment_ids;
      })
      .toEqual([keepId]);
    expect(dropId).not.toBe(keepId);
  });
});

test.describe('send keys', () => {
  test('Enter sends, Shift+Enter adds a line, an IME composition never sends, and the preference flips', async ({
    page,
  }) => {
    await openConversation(page);
    const box = message(page);
    await box.fill('line one');
    await box.press('Shift+Enter');
    await expect(box).toHaveValue('line one\n');
    const sent = async () => {
      const rows = await db('alpha')<{ n: number }[]>`
        select count(*)::int as n from tw_messages where role = 'member' and body like 'line one%'`;
      return rows[0]?.n ?? 0;
    };
    const before = await sent();
    await box.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    // An Enter that confirms an IME candidate must not send; the browser may still add a line.
    await box.press('Enter');
    await box.evaluate((node) => {
      node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await expect(box).toHaveValue(/^line one\n/);
    await expect(page.locator('.cp-foot')).not.toContainText('Sending');
    expect(await sent()).toBe(before);
    await page.getByRole('button', { name: /^Use Ctrl\+Enter/ }).click();
    await expect(page.getByText('Ctrl/Cmd+Enter to send')).toBeVisible();
    await box.fill('two');
    await box.press('Enter');
    await expect(box).toHaveValue('two\n');
    await page.reload();
    await expect(page.getByText('Ctrl/Cmd+Enter to send')).toBeVisible();
    await page.getByRole('button', { name: /^Use Enter/ }).click();
    await expect(page.getByText('Enter to send')).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get('/api/s/alpha/preferences')).json()) as {
              sendKey: string;
            }
          ).sendKey,
      )
      .toBe('enter');
  });

  test('@model rapid Enter plus a click yields one message row for the draft', async ({ page }) => {
    await openConversation(page);
    // A reply the previous test asked for may still be pending; the composer refuses sends until then.
    await expect(page.getByRole('status').filter({ hasText: 'Waiting for' })).toHaveCount(0, {
      timeout: 60_000,
    });
    const text = `once ${uuid()}`;
    await message(page).fill(text);
    // Open questions and revisable results make Send ask where this goes; choose chat explicitly.
    const target = page.getByRole('group', { name: 'Send target' });
    const chip = target.locator('.tg-chip');
    if (await chip.isVisible()) await chip.click();
    await target.getByRole('radio', { name: /^Reply to / }).check();
    await expect(target).toContainText(/^Reply to /);
    const hint = await page.locator('.cp-hint').first().innerText();
    const sendKey = hint.startsWith('Ctrl/Cmd+Enter') ? 'Control+Enter' : 'Enter';
    await message(page).press(sendKey, { delay: 0 });
    await message(page).press(sendKey, { delay: 0 });
    await page
      .getByRole('button', { name: 'Send' })
      .click({ force: true })
      .catch(() => undefined);
    await expect(message(page)).toHaveValue('');
    await expect
      .poll(async () => {
        const rows = await db('alpha')<{ n: number }[]>`
        select count(*)::int as n from tw_messages where role = 'member' and body = ${text}`;
        return rows[0]?.n;
      })
      .toBe(1);
    const requests = await db('alpha')<{ n: number }[]>`
      select count(distinct client_request_id)::int as n from tw_messages where role = 'member' and body = ${text}`;
    expect(requests[0]?.n).toBe(1);
  });
});

test.describe('conversation to work', () => {
  test('a source chip turns Send into a task draft card that the member reviews before Start', async ({
    page,
  }) => {
    await openConversation(page);
    await message(page).fill('Compare three analytics tools for the team ');
    const list = await openTrigger(page, '@');
    const files = list.getByRole('option', { name: /Files you attached/ });
    if (await files.isVisible()) await files.click();
    else await list.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Create task' }).click();
    const card = page.locator('.card[data-kind="task_draft"]');
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 3 })).toContainText(
      'Compare three analytics tools',
    );
    await expect(card.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Edit' })).toBeVisible();
    await expect(card.getByRole('list', { name: 'Specialists' }).getByRole('listitem')).toHaveCount(
      1,
    );
    await card.getByRole('button', { name: 'Add specialist' }).click();
    await page.getByRole('list', { name: 'Teammates to add' }).getByRole('button').first().click();
    await expect(card.getByRole('list', { name: 'Specialists' }).getByRole('listitem')).toHaveCount(
      2,
    );
    await card
      .getByRole('button', { name: /^Remove / })
      .last()
      .click();
    await expect(card.getByRole('list', { name: 'Specialists' }).getByRole('listitem')).toHaveCount(
      1,
    );
    await card.getByRole('radio', { name: 'Reviewed plan (coordinator)' }).check();
    await expect(card).toContainText('You approve that plan before anything runs');
    await card.getByRole('button', { name: 'Discard' }).click();
    await expect(card).toBeHidden();
    await expect(message(page)).toHaveValue(/^Compare three analytics tools for the team\s?$/);
  });

  test('@model Start posts one task with the conversation and files, then the task card appears', async ({
    page,
  }) => {
    await openConversation(page);
    await attach(page, 'brief.md', '# Brief\nCompare tools by access control.');
    await expect(page.locator('.cx-ready')).toHaveCount(1);
    const [fileId] = await attachmentIds(['brief.md']);
    const objective = `Compare analytics tools ${uuid()}`;
    await message(page).fill(objective);
    await plus(page).click();
    await page.getByRole('option', { name: /Create task/ }).click();
    const card = page.locator('.card[data-kind="task_draft"]');
    await expect(card).toBeVisible();
    // The last conversation decides the inferred workflow; a research brief needs only the file.
    await card.getByRole('combobox', { name: 'Workflow' }).selectOption('research_brief');
    await expect(card.locator('.td-owner')).toContainText('Result owner');
    await expect(card.locator('.td-problems'), 'the draft names nothing missing').toHaveCount(0);
    const start = card.getByRole('button', { name: 'Start' });
    await start.click();
    // A second press while the card is busy or already gone must not create a second task.
    await start.click({ force: true, timeout: 1000 }).catch(() => undefined);
    await expect(card).toBeHidden();
    await expect(message(page)).toHaveValue('');
    await expect(page.getByRole('list', { name: 'Conversation' })).toContainText(/Task|task/);
    await expect
      .poll(async () => {
        const rows = await db('alpha')<{ n: number }[]>`
        select count(*)::int as n from wb_tasks
        where owner_sub = 'local-test:alice' and kind = 'teamwork' and objective = ${objective}`;
        return rows[0]?.n;
      })
      .toBe(1);
    const task = await db('alpha')<{ files: string[] | null; conversation_id: string | null }[]>`
      select scope->'attachmentIds' as files, conversation_id from wb_tasks
      where owner_sub = 'local-test:alice' and kind = 'teamwork' and objective = ${objective}`;
    expect(task[0]?.files).toEqual([fileId]);
    expect(task[0]?.conversation_id).not.toBeNull();
  });
});
