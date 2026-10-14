import { readFileSync } from 'node:fs';

import { createPostgresDispatchPort } from '../../apps/api/dist/ledger/postgres-dispatch.js';
import { createPostgresLedgerPort } from '../../apps/api/dist/ledger/postgres-ledger.js';
import { createDlqService } from '../../apps/api/dist/reliability/dlq-service.js';
import { openDrillDatabase } from '../../apps/api/dist/reliability/drill-database.js';
import { createPostgresDlqStore } from '../../apps/api/dist/reliability/postgres-dlq.js';

async function main() {
  const action = process.argv[2];
  const fixture = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const sql = await openDrillDatabase(fixture.databaseUrl);
  try {
    const clock = () => new Date(fixture.now);
    const service = createDlqService(
      createPostgresDlqStore(sql),
      createPostgresDispatchPort(sql, clock),
      createPostgresLedgerPort(sql, clock),
    );
    let result;
    if (action === 'list') result = await service.list();
    else if (action === 'requeue')
      result = await service.requeue(
        fixture.entryId,
        fixture.review,
        fixture.lease,
        fixture.at,
        fixture.attempt,
      );
    else if (action === 'compensate')
      result = await service.compensate(fixture.entryId, fixture.review, fixture.evidenceRef);
    else throw new Error('action');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally {
    await sql.end({ timeout: 1 });
  }
}
try {
  await main();
} catch {
  process.stderr.write(
    'Offline DLQ review failed; inspect fixture evidence without replaying writes.\n',
  );
  process.exitCode = 1;
}
