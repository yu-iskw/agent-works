import { readFileSync } from 'node:fs';

import { runRestoreDrill } from '../../apps/api/dist/reliability/restore-drill.js';

try {
  const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(JSON.stringify(await runRestoreDrill(request), null, 2) + '\n');
} catch {
  process.stderr.write('Disposable restore drill failed. No live restore was attempted.\n');
  process.exitCode = 1;
}
