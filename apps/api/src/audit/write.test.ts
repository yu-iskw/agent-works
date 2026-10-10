import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUDIT_COLUMNS } from './write.js';

const auditMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations/0001_audit.sql',
);

describe('audit columns', () => {
  it('matches 0001_audit.sql', () => {
    const sql = readFileSync(auditMigrationPath, 'utf8');
    const columns = [...sql.matchAll(/^\s{2}([a-z0-9_]+) /gm)].map((match) => match[1]);
    expect(columns).toEqual([...AUDIT_COLUMNS]);
  });
});
