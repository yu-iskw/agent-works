import { pathToFileURL } from 'node:url';

import { contractReport, schemaReport } from './schema-contract.js';

function isDirectRun(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectRun()) {
  const check = process.argv.includes('--check');
  Promise.all([schemaReport(check), contractReport(check)])
    .then(([schemas, contracts]) => {
      if (check) {
        process.stdout.write(`${schemas}\n${contracts}\n`);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'schema check failed';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}
