import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const resultsPath = 'e2e/artifacts/results.json';

export function appendResult(entry) {
  mkdirSync('e2e/artifacts', { recursive: true });
  const tests = readTests().filter((item) => item.id !== entry.id);
  tests.push(entry);
  writeFileSync(resultsPath, `${JSON.stringify({ tests }, null, 2)}\n`);
}

function readTests() {
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8'));
    return Array.isArray(parsed.tests) ? parsed.tests : [];
  } catch {
    return [];
  }
}
