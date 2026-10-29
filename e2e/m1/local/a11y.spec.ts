import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { ensureStarterTeam, shot, signInLocal } from '../helpers.js';

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const PAGES = [
  'inbox',
  'teammates',
  'tasks',
  'tasks/new',
  'catalog',
  'connections',
  'import',
] as const;

test('key pages have no critical or serious axe violations and no horizontal overflow at 375, 768 and 1440', async ({
  page,
}) => {
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const failures: string[] = [];
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    for (const path of PAGES) {
      await page.goto(`/s/alpha/${path}`);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      for (const violation of result.violations.filter(
        (v) => v.impact === 'critical' || v.impact === 'serious',
      ))
        failures.push(`${viewport.name} ${path}: ${violation.id} (${violation.nodes.length})`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1)
        failures.push(`${viewport.name} ${path}: horizontal overflow ${overflow}px`);
      await shot(page, `00-${path.replaceAll('/', '-')}-${viewport.name}`);
    }
  }
  expect(failures).toEqual([]);
});

test('the segment and member stay identifiable on a narrow screen, and navigation works by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signInLocal(page);
  const segmentBar = page.getByRole('note', { name: 'Active segment' });
  await expect(segmentBar).toContainText('Alpha Retail');
  await expect(segmentBar, 'mock and fixture modes are labelled at 375 px').toContainText(
    'Mock identity',
  );
  await expect(segmentBar).toContainText('Fixture sources');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.getByRole('button', { name: 'Menu' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'New task' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  await page.getByLabel(/Switch segment/).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /Beta Health/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('note', { name: 'Active segment' })).toContainText('Beta Health');
  await shot(page, '16-segment-switch-375');
});

test('reduced motion turns animations off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await signInLocal(page);
  await ensureStarterTeam(page, 'alpha');
  const duration = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'status status-active';
    document.body.append(probe);
    return getComputedStyle(probe, '::before').animationDuration;
  });
  expect(Number.parseFloat(duration)).toBeLessThan(0.01);
});
