import { readFileSync, writeFileSync } from 'node:fs';

import { writePng } from '../png.mjs';

const pending = JSON.parse(readFileSync(new URL('./pending-tests.json', import.meta.url), 'utf8'));

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
