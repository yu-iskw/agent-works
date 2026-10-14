import { readFileSync, writeFileSync } from 'node:fs';
import { buildSpec, assertNoDrift } from './spec.mjs';
import { buildClient } from './client.mjs';
import { canonicalClient } from './client-source.mjs';
const root = new URL('../', import.meta.url);
const spec = buildSpec();
const files = new Map([
  ['openapi.json', JSON.stringify(spec, null, 2) + '\n'],
  ['src/client.generated.ts', buildClient(spec)],
]);
if (process.argv.includes('--check')) {
  assertNoDrift(JSON.parse(readFileSync(new URL('openapi.json', root), 'utf8')), spec);
  // Compare generated TypeScript structurally after formatting to keep Prettier canonical.
  for (const name of ['src/client.generated.ts']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    const expected = files.get(name);
    if (canonicalClient(source) !== canonicalClient(expected))
      throw new Error(`generated client drift: ${name}`);
  }
} else for (const [name, body] of files) writeFileSync(new URL(name, root), body);
