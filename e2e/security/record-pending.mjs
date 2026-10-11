import { writeFileSync } from 'node:fs';

import { readPendingCatalog } from '../pending/read-catalog.mjs';
import { writePng } from '../png.mjs';

const pending = readPendingCatalog('e2e/pending');

for (const row of pending) {
  writePng(`e2e/artifacts/${row.id}/${row.id.replaceAll('.', '-')}.png`, 'pending');
}

writeFileSync(
  'e2e/artifacts/results.json',
  `${JSON.stringify(
    {
      tests: pending.map((row) => ({ id: row.id, status: 'pending', owner: row.owner })),
    },
    null,
    2,
  )}\n`,
);
