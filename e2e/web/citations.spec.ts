import { expect, test } from '@playwright/test';

const citations = [
  {
    sourceObjectId: 'alice-runbook',
    title: 'Triage runbook',
    sourceUri: 'https://drive.fake.test/d/alice-runbook',
    etag: 'v1',
    retrievedAt: '2026-10-10T10:00:00.000Z',
    accessDecisionId: 'decision-1',
    excerpt: 'Follow the triage steps.',
  },
  {
    sourceObjectId: 'public-handbook',
    title: 'Public handbook',
    sourceUri: 'https://drive.fake.test/d/public-handbook',
    etag: 'v2',
    retrievedAt: '2026-10-10T11:00:00.000Z',
    accessDecisionId: 'decision-2',
    excerpt: 'Anyone may read this handbook.',
  },
] as const;

test('citations.fields-present', async ({ page }) => {
  const response = await page.request.post('/citations', { data: citations });
  expect(response.status()).toBe(200);
  await page.setContent(await response.text());

  const list = page.getByRole('list', { name: 'Citations' });
  for (const citation of citations) {
    const item = list.getByRole('listitem').filter({ hasText: citation.title });
    const retrieved = item.getByRole('time');
    await expect(item.getByRole('link', { name: citation.title })).toHaveAttribute(
      'href',
      citation.sourceUri,
    );
    await expect(retrieved).toHaveAttribute('datetime', citation.retrievedAt);
    await expect(retrieved).toHaveText(citation.retrievedAt);
    await expect(item.getByText('Source data', { exact: true })).toBeVisible();
    await expect(item.getByText(citation.excerpt, { exact: true })).toBeVisible();
    await expect(item.getByText(citation.sourceObjectId, { exact: true })).toBeVisible();
    await expect(item.getByText(citation.etag, { exact: true })).toBeVisible();
    await expect(item.getByText(citation.accessDecisionId, { exact: true })).toBeVisible();
  }
});
