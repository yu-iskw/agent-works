import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';

import { expect, test } from '@playwright/test';

import type * as FakeCaller from '../../apps/api/src/retrieval/fake-caller.js';
import type * as HttpDrive from '../../apps/api/src/retrieval/http-drive.js';
import type * as Directory from '../../packages/fakes/src/fake-directory.js';
import type * as Fakes from '../../packages/fakes/src/index.js';

const group = 'agent-users@company.example';
const bobTitle = 'Bob private notes';

// Playwright loads these specs as CommonJS, so the ESM-only workspace packages
// can only be reached through built output and a native dynamic import.
// `playwright test security --list` never runs a test body and needs no build.
function load<T>(path: string): Promise<T> {
  return import(pathToFileURL(resolve(path)).href) as Promise<T>;
}

async function world() {
  const fakes = await load<typeof Fakes>('packages/fakes/dist/index.js');
  const { createDirectory } = await load<typeof Directory>('packages/fakes/dist/fake-directory.js');
  const { createHttpDrive } = await load<typeof HttpDrive>('apps/api/dist/retrieval/http-drive.js');
  const callers = await (
    await load<typeof FakeCaller>('apps/api/dist/retrieval/fake-caller.js')
  ).startFakeCallers();
  const closers: (() => Promise<void>)[] = [() => callers.close()];
  const serve = async (handler: Parameters<typeof fakes.listen>[0]) => {
    const server = await fakes.listen(handler, 0);
    closers.push(server.close);
    return server.url;
  };
  const directoryUrl = await serve(createDirectory());
  const driveUrl = await serve(fakes.createDrive(directoryUrl));
  return {
    directoryUrl,
    driveUrl,
    drive: createHttpDrive({ baseUrl: driveUrl, directoryUrl }),
    driveWith: (baseUrl: string) => createHttpDrive({ baseUrl, directoryUrl }),
    serve,
    caller: (sub: string) => callers.as(sub),
    async documentsFor(caller: { assertion: string }) {
      const response = await fetch(`${driveUrl}/documents`, {
        headers: { 'x-goog-iap-jwt-assertion': caller.assertion },
      });
      return (await response.json()) as unknown[];
    },
    async close() {
      for (const close of closers.reverse()) await close();
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function evidence(sections: Record<string, readonly string[]>): string {
  const body = Object.entries(sections)
    .map(
      ([name, titles]) =>
        `<section aria-label="${escapeHtml(name)}"><h2>${escapeHtml(name)}</h2><ul>${titles.map((title) => `<li>${escapeHtml(title)}</li>`).join('')}</ul></section>`,
    )
    .join('');
  return `<body style="font:16px sans-serif">${body}</body>`;
}

test('sec.cross-user-leak', async ({ page }) => {
  const stack = await world();
  try {
    const [alice, bob] = [await stack.caller('alice'), await stack.caller('bob')];
    const leakyUrl = await stack.serve(async () => ({
      status: 200,
      body: [...(await stack.documentsFor(alice)), ...(await stack.documentsFor(bob))],
    }));
    const leaky = stack.driveWith(leakyUrl);
    const brokenUrl = await stack.serve(() => ({ status: 200, body: `${bobTitle} is not json` }));
    const error = await stack
      .driveWith(brokenUrl)
      .retrieve(alice, 'notes')
      .catch((caught: unknown) => caught);

    const titles = async (drive: typeof leaky, who: typeof alice) =>
      (await drive.retrieve(who, 'Bob salary notes')).map((source) => source.title);
    await page.setContent(
      evidence({
        'alice via leaky drive': await titles(leaky, alice),
        'bob via leaky drive': await titles(leaky, bob),
        'alice via real drive': await titles(stack.drive, alice),
        'alice error dump': [String((error as Error).message)],
      }),
    );

    await expect(
      page.getByRole('region', { name: 'alice via leaky drive' }).getByRole('listitem'),
    ).toHaveCount(0);
    await expect(
      page.getByRole('region', { name: 'alice via real drive' }).getByRole('listitem'),
    ).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'bob via leaky drive' })).toContainText(bobTitle);
    expect(inspect(error, { depth: null, showHidden: true })).not.toContain('Bob p');
  } finally {
    await stack.close();
  }
});

test('sec.revoked-group', async ({ page }) => {
  const stack = await world();
  try {
    const alice = await stack.caller('alice');
    const stale = await stack.documentsFor(alice);
    const staleUrl = await stack.serve(() => ({ status: 200, body: stale }));
    const ask = (drive: typeof stack.drive) =>
      drive.retrieve(alice, 'benefits coverage triage runbook');
    const before = (await ask(stack.drive)).map((source) => source.title);

    const revoked = await fetch(`${stack.directoryUrl}/revocations`, {
      method: 'POST',
      body: JSON.stringify({ sub: 'alice', group }),
    });
    expect(revoked.status).toBe(200);

    const after = (await ask(stack.drive)).map((source) => source.title);
    const afterStale = (await ask(stack.driveWith(staleUrl))).map((source) => source.title);
    await page.setContent(evidence({ before, after, 'after, drive still stale': afterStale }));

    await expect(page.getByRole('region', { name: 'before' })).toContainText(
      'Shared benefits guide',
    );
    for (const name of ['after', 'after, drive still stale']) {
      const region = page.getByRole('region', { name, exact: true });
      await expect(region).not.toContainText('Shared benefits guide');
      await expect(region).toContainText('Triage runbook');
    }
  } finally {
    await stack.close();
  }
});
