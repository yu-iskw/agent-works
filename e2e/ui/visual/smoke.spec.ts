import { test } from '@playwright/test';

import { captureForBaseline } from '../helpers.js';

const widths = [375, 768, 1440] as const;

for (const width of widths) {
  test(`sign-in at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/sign-in');
    await captureForBaseline(page, `sign-in-${width}-light`);
  });
}
