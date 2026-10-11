import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readPendingCatalog(directory) {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const pending = [];
  const seen = new Set();
  for (const name of names) {
    const owner = name.slice(0, -'.json'.length);
    const rows = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    if (!Array.isArray(rows)) throw new Error(`${name} must be a list`);
    for (const row of rows) {
      if (row === null || typeof row !== 'object') throw new Error(`${name} row must be an object`);
      const id = row.id;
      const rowOwner = row.owner;
      if (typeof id !== 'string' || typeof rowOwner !== 'string') {
        throw new Error(`${name} row needs an id and an owner`);
      }
      if (rowOwner !== owner) throw new Error(`${id} owner ${rowOwner} is not ${owner}`);
      if (seen.has(id)) throw new Error(`${id} is listed twice`);
      seen.add(id);
      pending.push({ id, owner: rowOwner });
    }
  }
  return pending;
}
