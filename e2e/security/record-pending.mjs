import { readPendingCatalog } from '../pending/read-catalog.mjs';
import { writePng } from '../png.mjs';
import { appendResult } from '../results.mjs';

const pending = readPendingCatalog('e2e/pending');

for (const row of pending) {
  appendResult({ id: row.id, status: 'pending', owner: row.owner });
  writePng(`e2e/artifacts/${row.id}/${row.id.replaceAll('.', '-')}.png`, 'pending');
}
