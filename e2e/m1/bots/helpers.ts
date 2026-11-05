import { expect } from '@playwright/test';

import { db, ensureStarterTeam, signInLocal, teammateId } from '../helpers.js';

import type { Page } from '@playwright/test';

export async function openBot(page: Page): Promise<string> {
  expect((await page.request.get('/sign-in')).ok()).toBe(true);
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const id = await teammateId(page, 'alpha', 'Coordinator');
  const rows = await db('alpha')<{ conversation_id: string }[]>`
    select conversation_id from tw_teammates where id = ${id}`;
  const conversation = rows[0]?.conversation_id;
  if (!conversation) throw new Error('Coordinator conversation missing');
  const csrf = await page.locator('form[action="/auth/sign-out"] input[name="csrf"]').inputValue();
  const upload = await page.request.post(`/api/s/alpha/conversations/${conversation}/attachments`, {
    headers: { origin: 'http://web:8080', 'x-csrf-token': csrf },
    data: { name: 'research.txt', mediaType: 'text/plain', text: 'Fixture research findings.' },
  });
  expect(upload.status()).toBe(201);
  await page.goto(`/s/alpha/bots/${id}`);
  await expect(page.getByRole('heading', { name: 'Bot workflows unavailable' })).toHaveCount(0);
  return id;
}

export async function requestDesign(page: Page, message: string): Promise<void> {
  await page.getByLabel('Your request').fill(message);
  await page.getByRole('button', { name: 'Send design request' }).click();
}
