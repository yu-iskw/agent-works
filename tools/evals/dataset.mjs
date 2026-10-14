import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { validateCase } from './schema.mjs';

const base = new URL('../../evals/v1/', import.meta.url);
const allowedSplits = new Set(['dev', 'holdout', 'adversarial']);

export function parseJsonl(text, split) {
  if (!allowedSplits.has(split)) throw new Error('unknown split');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error('empty dataset');
  const seen = new Set();
  return lines.map((line, index) => {
    try {
      const row = validateCase(JSON.parse(line));
      if (row.split !== split) throw new Error('wrong split');
      if (seen.has(row.id)) throw new Error('duplicate case ID');
      seen.add(row.id);
      return row;
    } catch {
      // Never echo potentially protected input in diagnostics.
      throw new Error(`invalid ${split} dataset row ${index + 1}`);
    }
  });
}

export function loadDataset({ splits = ['dev', 'adversarial'], includeHoldout = false } = {}) {
  if (!Array.isArray(splits) || splits.length === 0 || new Set(splits).size !== splits.length)
    throw new Error('invalid split selection');
  if (splits.includes('holdout') && !includeHoldout)
    throw new Error('holdout requires explicit opt-in');
  const cases = [];
  const fingerprints = {};
  for (const split of splits) {
    if (!allowedSplits.has(split)) throw new Error('unknown split');
    const text = readFileSync(new URL(`${split}.jsonl`, base), 'utf8');
    fingerprints[split] = createHash('sha256').update(text).digest('hex');
    cases.push(...parseJsonl(text, split));
  }
  return { cases, fingerprints, splits: [...splits] };
}
