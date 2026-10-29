import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  ensureStarterTeam,
  signInLocal,
  taskIdFrom,
  teammateId,
  waitForStatus,
} from '../helpers.js';

import type { Page } from '@playwright/test';

// UI review tour on the scripted-model stack (pnpm m1:ux <round>): no Vertex calls.
const ROUND = process.env.M1_UX_ROUND ?? '0';
const DIR = `artifacts/m1/ux/round-${ROUND}`;
const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
] as const;

async function manualResearch(page: Page, question: string): Promise<string> {
  const research = await teammateId(page, 'alpha', 'Research analyst');
  const risk = await teammateId(page, 'alpha', 'Risk and compliance reviewer');
  await page.goto('/s/alpha/tasks/new');
  await page.getByLabel('What do you need?').fill(question);
  await page.getByLabel('Specialist 1').selectOption(research);
  await page
    .getByLabel('Assignment')
    .nth(0)
    .fill('Compare Flagship, Togglr and OpenFlags on price, SLA and EU residency.');
  await page.getByLabel('Specialist 2').selectOption(risk);
  await page.getByLabel('Assignment').nth(1).fill('Find conflicting figures and stale documents.');
  await page.getByRole('button', { name: 'Start task' }).click();
  return taskIdFrom(page);
}

test('UX tour: key journey on video, then every key screen at 375, 768 and 1440', async ({
  page,
}) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  mkdirSync(DIR, { recursive: true });
  // Screens are captured the moment they exist, so a later step cannot change what they show.
  const add = async (name: string, prepare?: (page: Page) => Promise<void>) => {
    const url = page.url();
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(url);
      await prepare?.(page);
      await page.screenshot({ path: `${DIR}/${name}-${viewport.name}.png`, fullPage: true });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect
        .soft(overflow, `${name} at ${viewport.name} px overflows horizontally`)
        .toBeLessThanOrEqual(1);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
  };

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.goto('/sign-in');
    await page.screenshot({ path: `${DIR}/01-sign-in-${viewport.name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInLocal(page);
  await add('02-inbox');
  await ensureStarterTeam(page, 'alpha');
  await add('03-teammates');

  const coordinator = await teammateId(page, 'alpha', 'Coordinator');
  await page.goto(`/s/alpha/teammates/${coordinator}`);
  await page.getByLabel('Message').fill('How would you split a vendor comparison?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.msg-teammate').first()).toBeVisible({ timeout: 30_000 });
  await add('04-teammate-conversation');

  await page.goto('/s/alpha/catalog');
  await add('05-catalog');
  await page.getByRole('link', { name: 'Evidence-first comparison' }).first().click();
  await add('06-skill');
  await page.goto('/s/alpha/tasks/new');
  await add('07-new-task-research');
  await page.goto('/s/alpha/tasks/new?workflow=metrics_explanation');
  await add('08-new-task-metrics');

  const brief = await manualResearch(
    page,
    'Which feature-flag service should the platform team adopt before the EU contract starts?',
  );
  await add('09-task-running');
  await waitForStatus(page, 'alpha', brief, ['ready', 'failed'], 120_000);
  await page.goto(`/s/alpha/tasks/${brief}`);
  await add('10-task-ready');
  await page.locator('.cite').first().click();
  await add('11-evidence-open');
  await page
    .getByLabel('Request a revision')
    .fill('Treat the Togglr SLA as unresolved and add the migration effort.');
  await page.getByRole('button', { name: 'Request revision' }).click();
  await waitForStatus(page, 'alpha', brief, ['ready', 'failed'], 120_000);
  await page.goto(`/s/alpha/tasks/${brief}/compare?from=1&to=2`);
  await add('12-revision-compare');
  await page.goto(`/s/alpha/tasks/${brief}`);
  await page.getByRole('button', { name: 'Prepare revision 2 for Google Docs' }).click();
  await add('13-action-approval');
  await page.getByRole('button', { name: 'Approve and create the document' }).click();
  await waitForStatus(page, 'alpha', brief, ['completed', 'failed', 'outcome_uncertain'], 60_000);
  await page.goto(`/s/alpha/tasks/${brief}`);
  await add('14-published');

  await page.goto('/s/alpha/tasks/new');
  await page
    .getByLabel('What do you need?')
    .fill('Which appointment-reminder channel should clinics adopt?');
  await page.getByRole('radio', { name: /Coordinator proposes a plan/ }).check();
  await page.getByRole('button', { name: 'Start task' }).click();
  const planned = taskIdFrom(page);
  await waitForStatus(page, 'alpha', planned, ['plan_review', 'failed'], 60_000);
  await page.goto(`/s/alpha/tasks/${planned}`);
  await add('15-plan-review');

  await page.goto('/s/alpha/tasks/new?workflow=metrics_explanation');
  await page
    .getByLabel('What do you need?')
    .fill('Why did signups change between September and October?');
  const data = await page
    .getByLabel('Specialist 1')
    .locator('option', { hasText: 'Data analyst ·' })
    .getAttribute('value');
  await page.getByLabel('Specialist 1').selectOption(data ?? '');
  await page.getByLabel('Assignment').nth(0).fill('Report the largest changes with exact values.');
  await page.getByRole('button', { name: 'Start task' }).click();
  const metrics = taskIdFrom(page);
  await waitForStatus(page, 'alpha', metrics, ['ready', 'failed'], 120_000);
  await page.goto(`/s/alpha/tasks/${metrics}`);
  await add('16-metrics-result');

  const failing = await manualResearch(page, 'Compare vendors [fault:denied]');
  await waitForStatus(page, 'alpha', failing, ['needs_input'], 60_000);
  await page.goto(`/s/alpha/tasks/${failing}`);
  await add('17-needs-input');

  await page.goto('/s/alpha/inbox');
  await add('18-inbox-with-items');
  await page.goto('/s/alpha/connections');
  await add('19-connections');
  await page.goto(`/s/alpha/teammates/${coordinator}/export`);
  await add('20-export');
  await page.goto('/s/alpha/import');
  await add('21-import');
  await page.goto('/s/alpha/inbox');
  await add('22-segment-switch', async (p) => {
    await p.getByLabel(/Switch segment/).click();
  });
});
