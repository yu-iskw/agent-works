import { mkdirSync, writeFileSync } from 'node:fs';

import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { db } from '../../m1/helpers.js';
import {
  busiestConversation,
  revisedTask,
  seedHistory,
  seedRunningCard,
  signInLocal,
} from '../helpers.js';

import type { Page } from '@playwright/test';

// Axe over every required state at phone, tablet and desktop widths in both themes. Each state is
// reached through the real app against persisted journey results and seeded rows, so no model is
// called. A state also fails when the page scrolls sideways. Reduced motion is checked once.

const WIDTHS = [375, 768, 1440] as const;
const THEMES = ['light', 'dark'] as const;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const SUMMARY = 'artifacts/ui/axe-summary.json';

type Width = (typeof WIDTHS)[number];
type Theme = (typeof THEMES)[number];
type Ids = {
  readonly busy: { teammateId: string; conversationId: string };
  readonly seeded: Awaited<ReturnType<typeof seedHistory>>;
  readonly revised: NonNullable<Awaited<ReturnType<typeof revisedTask>>>;
  readonly planned: { taskId: string; teammateId: string; version: number } | undefined;
  readonly approval: { taskId: string; teammateId: string; approvalId: string } | undefined;
};

type Scan = {
  readonly state: string;
  readonly width: Width;
  readonly theme: Theme;
  readonly violations: readonly {
    id: string;
    impact: string;
    nodes: number;
    help: string;
    /** The first offending elements: selector, markup head and axe's reason. */
    examples: readonly { target: string; html: string; reason: string }[];
  }[];
  readonly overflow: boolean;
};

const results: Scan[] = [];

async function ids(): Promise<Ids> {
  const [busy, seeded, revised, plans, approvals] = await Promise.all([
    busiestConversation(),
    seedHistory(120),
    revisedTask('alpha'),
    db('alpha')<{ task_id: string; teammate_id: string; version: number }[]>`
      select p.task_id, c.teammate_id, p.version from tw_plans p
      join wb_tasks t on t.id = p.task_id
      join tw_conversations c on c.id = t.conversation_id
      where t.owner_sub = 'local-test:alice' order by p.created_at desc limit 1`,
    db('alpha')<{ id: string; task_id: string; teammate_id: string }[]>`
      select ap.id, ap.task_id, c.teammate_id from wb_approvals ap
      join wb_tasks t on t.id = ap.task_id
      join tw_conversations c on c.id = t.conversation_id
      where t.owner_sub = 'local-test:alice' and ap.subject = 'publish'
      order by ap.requested_at desc limit 1`,
  ]);
  if (revised === undefined) throw new Error('no alpha task of alice with two revisions');
  await seedRunningCard(seeded);
  const plan = plans.at(0);
  const approval = approvals.at(0);
  return {
    busy,
    seeded,
    revised,
    planned:
      plan === undefined
        ? undefined
        : { taskId: plan.task_id, teammateId: plan.teammate_id, version: plan.version },
    approval:
      approval === undefined
        ? undefined
        : { taskId: approval.task_id, teammateId: approval.teammate_id, approvalId: approval.id },
  };
}

const at = (teammateId: string, rest = '') => `/s/alpha/teammates/${teammateId}${rest}`;
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' });

/** Phone widths keep the sidebar in a sheet; opening it is part of the state. */
async function openSidebar(page: Page): Promise<void> {
  const open = page.getByRole('button', { name: 'Open the sidebar' });
  if (await open.isVisible()) await open.click();
}

/** Every required state: name and how to reach it from a signed-in page. */
function states(i: Ids): readonly { name: string; go: (page: Page) => Promise<void> }[] {
  const r = i.revised;
  const result = at(r.teammateId, `/tasks/${r.taskId}/results/${r.latest}`);
  const visible = (page: Page, text: string) =>
    expect(page.getByRole('heading', { level: 2, name: text })).toBeVisible();
  return [
    {
      name: 'conversation',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId));
        await expect(composer(page)).toBeVisible();
      },
    },
    {
      name: 'composer @ menu open',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId));
        await composer(page).click();
        await page.keyboard.type('@');
        await expect(page.getByRole('listbox')).toBeVisible();
      },
    },
    {
      name: 'composer + menu open',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId));
        await page.getByRole('button', { name: 'Add to the message' }).click();
        await expect(page.getByRole('listbox', { name: 'Add to the message' })).toBeVisible();
      },
    },
    {
      name: 'task draft card',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId));
        await composer(page).fill('Compare three analytics tools for the team');
        await page.getByRole('button', { name: 'Add to the message' }).click();
        await page.getByRole('option', { name: /Create task/ }).click();
        await expect(page.locator('.card[data-kind="task_draft"]')).toBeVisible();
      },
    },
    {
      name: 'running card',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId));
        await expect(page.locator('.card[data-kind="running"]').last()).toBeVisible();
      },
    },
    {
      name: 'plan card and result card',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId));
        await expect(page.getByRole('button', { name: 'Open result' }).last()).toBeVisible();
      },
    },
    {
      name: 'result panel: Result',
      go: async (page) => {
        await page.goto(result);
        await visible(page, 'Result');
      },
    },
    {
      name: 'result panel: Sources',
      go: async (page) => {
        await page.goto(`${result}/sources`);
        await expect(page.getByRole('tab', { name: 'Sources' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      },
    },
    {
      name: 'result panel: Changes',
      go: async (page) => {
        await page.goto(`${result}/changes`);
        await expect(page.getByRole('tab', { name: 'Changes' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      },
    },
    {
      name: 'task panel (running)',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId, `/tasks/${i.seeded.runningTaskId}`));
        await visible(page, 'Task');
      },
    },
    ...(i.planned === undefined
      ? []
      : [
          {
            name: 'plan panel',
            go: async (page: Page) => {
              const p = i.planned!;
              await page.goto(at(p.teammateId, `/tasks/${p.taskId}/plan/${p.version}`));
              await visible(page, 'Plan');
            },
          },
        ]),
    ...(i.approval === undefined
      ? []
      : [
          {
            name: 'approval card',
            go: async (page: Page) => {
              await page.goto(at(i.approval!.teammateId));
              await expect(page.locator('.card[data-kind="approval"]').last()).toBeVisible();
            },
          },
          {
            name: 'approval panel',
            go: async (page: Page) => {
              const a = i.approval!;
              await page.goto(at(a.teammateId, `/tasks/${a.taskId}/approvals/${a.approvalId}`));
              await visible(page, 'Review action');
            },
          },
        ]),
    {
      name: 'inbox',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId, '/inbox'));
        await visible(page, 'Attention inbox');
      },
    },
    {
      name: 'recap',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId, '/recap'));
        await visible(page, 'Coordinator recap');
      },
    },
    {
      name: 'sidebar Work',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId));
        await openSidebar(page);
        await page.getByRole('tab', { name: 'Work' }).click();
        await expect(
          page.getByRole('list', { name: 'Work' }).getByRole('listitem').first(),
        ).toBeVisible();
      },
    },
    {
      name: 'sidebar Results',
      go: async (page) => {
        await page.goto(at(i.seeded.teammateId));
        await openSidebar(page);
        await page.getByRole('tab', { name: 'Results' }).click();
        await expect(
          page.getByRole('list', { name: 'Results' }).getByRole('listitem').first(),
        ).toBeVisible();
      },
    },
    {
      name: 'teammate details',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId, '/details'));
        await visible(page, 'Teammate details');
      },
    },
    {
      name: 'preferences',
      go: async (page) => {
        await page.goto(at(i.busy.teammateId, '/preferences'));
        await visible(page, 'Preferences');
      },
    },
  ];
}

async function scan(page: Page, state: string, width: Width, theme: Theme): Promise<Scan> {
  const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return root.scrollWidth > root.clientWidth;
  });
  const scanned: Scan = {
    state,
    width,
    theme,
    violations: axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? 'unknown',
      nodes: v.nodes.length,
      help: v.help,
      examples: v.nodes.slice(0, 3).map((n) => ({
        target: n.target.join(' '),
        html: n.html.slice(0, 160),
        reason: n.any[0]?.message ?? n.all[0]?.message ?? '',
      })),
    })),
    overflow,
  };
  results.push(scanned);
  return scanned;
}

test.describe('accessibility', () => {
  let i: Ids;
  test.beforeAll(async () => {
    i = await ids();
  });
  test.afterAll(() => {
    mkdirSync('artifacts/ui', { recursive: true });
    writeFileSync(SUMMARY, JSON.stringify(results, null, 2));
  });

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      test(`zero critical or serious violations and no sideways scroll at ${width}px in ${theme}`, async ({
        page,
      }) => {
        test.setTimeout(300_000);
        await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
        await page.emulateMedia({ colorScheme: theme });
        await signInLocal(page, 'alice@local.test');
        await page.goto(at(i.busy.teammateId));
        if ((await page.locator('html').getAttribute('data-theme')) !== null) {
          await page.goto(at(i.busy.teammateId, '/preferences'));
          await page.getByRole('radio', { name: 'System' }).check();
        }
        await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
        const failures: string[] = [];
        for (const state of states(i)) {
          await state.go(page);
          const scanned = await scan(page, state.name, width, theme);
          const serious = scanned.violations.filter(
            (v) => v.impact === 'critical' || v.impact === 'serious',
          );
          for (const v of serious)
            failures.push(
              `${state.name}: ${v.id} (${v.impact}, ${v.nodes} nodes) ${v.help} [${v.examples[0]?.target ?? ''}] ${v.examples[0]?.reason ?? ''}`,
            );
          if (scanned.overflow) failures.push(`${state.name}: horizontal page overflow`);
        }
        expect(failures, failures.join('\n')).toEqual([]);
      });
    }
  }

  test('prefers-reduced-motion disables every transition and animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signInLocal(page, 'alice@local.test');
    await page.goto(at(i.seeded.teammateId, `/tasks/${i.seeded.runningTaskId}`));
    await expect(page.getByRole('heading', { level: 2, name: 'Task' })).toBeVisible();
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('*')].flatMap((el) => {
        const style = getComputedStyle(el);
        const before = getComputedStyle(el, '::before');
        const animated =
          style.animationName !== 'none' ||
          before.animationName !== 'none' ||
          style.transitionDuration.split(',').some((d) => d.trim() !== '0s');
        return animated ? [`${el.tagName.toLowerCase()}.${el.className}`] : [];
      }),
    );
    expect(moving).toEqual([]);
  });
});
