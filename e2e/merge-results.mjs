import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let names = [];
try {
  names = readdirSync('parts');
} catch {
  names = [];
}
mkdirSync('e2e/artifacts', { recursive: true });
const tests = [];
let missing = [
  'e2e-part-contract',
  'e2e-part-stack',
  'e2e-part-web',
  'e2e-part-security',
  'e2e-part-pending',
].some((prefix) => !names.some((name) => name.startsWith(prefix)));
for (const name of names.filter((entry) => entry.startsWith('e2e-part-')).sort()) {
  const dir = join('parts', name);
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    if (Array.isArray(parsed.tests)) tests.push(...parsed.tests);
    else missing = true;
  } catch {
    missing = true;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      cpSync(join(dir, entry.name), join('e2e/artifacts', entry.name), { recursive: true });
    }
  }
}
writeFileSync('e2e/artifacts/results.json', `${JSON.stringify({ tests }, null, 2)}\n`);
if (missing) process.exitCode = 1;
