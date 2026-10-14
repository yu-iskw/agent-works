import { expect, it } from 'vitest';

import { fixtureRequest } from './fixtures.js';
import { runRestoreDrill } from './restore-drill.js';

it('dumps and restores disposable Postgres with zero duplicate external writes', async () => {
  const report = await runRestoreDrill(fixtureRequest);
  expect(report).toEqual({
    mode: 'disposable-postgres',
    completedBeforeDump: 2,
    inFlightBeforeDump: 2,
    externalCreates: 4,
    duplicateCreates: 0,
    recoveredReceipts: 4,
    redrivenCompleted: 2,
    pass: true,
  });
}, 60_000);
