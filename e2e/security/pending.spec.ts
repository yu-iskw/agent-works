import { test } from '@playwright/test';

import { readPendingCatalog } from '../pending/read-catalog.mjs';

for (const row of readPendingCatalog('e2e/pending')) {
  test.fixme(row.id, { annotation: { type: 'owner', description: row.owner } }, () => {});
}
