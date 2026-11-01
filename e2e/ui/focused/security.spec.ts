import { expect, test } from '@playwright/test';

import { coordinator, signInLocal } from '../helpers.js';

// Response headers on every surface the browser loads: the workspace document, its JSON routes,
// the sign-in page and a fixture document. No model is called.

const PAGES = (teammateId: string) => [
  `/s/alpha/teammates/${teammateId}`,
  `/s/alpha/teammates/${teammateId}/inbox`,
  '/api/s/alpha/me',
  '/s/alpha/teammates',
  '/sign-in',
];

test('a content security policy without inline scripts guards every workspace response', async ({
  page,
}) => {
  await signInLocal(page, 'alice@local.test');
  const owner = await coordinator('alpha');
  for (const path of PAGES(owner.id)) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(csp, `${path} carries a CSP`).toMatch(/(^|;\s*)script-src 'self'(;|$)/);
    expect(csp, `${path} allows no inline script`).not.toContain('unsafe-inline');
    expect(csp, `${path} allows no eval`).not.toContain('unsafe-eval');
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['cache-control'], path).toBe('no-store');
  }
  // The shell carries its bootstrap as non-executing JSON, never as inline script.
  const html = await (await page.request.get(`/s/alpha/teammates/${owner.id}`)).text();
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1] ?? '');
  expect(scripts.length).toBeGreaterThan(0);
  for (const attributes of scripts)
    expect(
      attributes.includes('type="application/json"') || /\bsrc="\/assets\//.test(attributes),
      `script tag ${attributes}`,
    ).toBe(true);
});
