import { readFileSync } from 'node:fs';

import { writePng } from '../png.mjs';
import { appendResult } from '../results.mjs';

const exitCode = process.argv[2] ?? '1';
const reportPath = process.argv[3];
let failed = exitCode !== '0';
let report;

try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch {
  process.exit(1);
}

const assertions = [];
for (const result of report.testResults ?? []) {
  for (const assertion of result.assertionResults ?? []) {
    if (typeof assertion.title === 'string' && assertion.title.startsWith('contract.')) {
      assertions.push(assertion);
    }
  }
}

if (assertions.length === 0) failed = true;

for (const assertion of assertions) {
  const id = assertion.title;
  const status = assertion.status === 'passed' ? 'passed' : 'failed';
  if (status !== 'passed') failed = true;
  appendResult({ id, status });
  writePng(`e2e/artifacts/${id}/${id.replaceAll('.', '-')}.png`, status);
}

if (failed) process.exitCode = 1;
