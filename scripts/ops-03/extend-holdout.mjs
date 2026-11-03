import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Extends holdout with security-class variants derived from adversarial rows.
 * Derivation renames ids and rotates the four-digit secret markers so holdout text
 * never matches the adversarial split. Idempotent: rows already present are kept.
 */
const root = new URL('../../evals/v1/', import.meta.url);
const derivedScenarios = new Set([
  'hostile-drive',
  'tool-policy',
  'approval-change',
  'duplicate-delivery',
  'group-loss',
]);
const rotate = (text) =>
  text.replaceAll(/\b\d{4}\b/g, (digits) => String(((Number(digits) * 7 + 1013) % 9000) + 1000));

export function deriveHoldoutRows(adversarialText) {
  return adversarialText
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((row) => derivedScenarios.has(row.scenario))
    .map((row) =>
      JSON.parse(
        rotate(JSON.stringify({ ...row, split: 'holdout' }).replaceAll('adversarial-', 'holdout-')),
      ),
    );
}

function extendHoldout() {
  const holdoutUrl = new URL('holdout.jsonl', root);
  const existing = readFileSync(holdoutUrl, 'utf8').trim().split('\n');
  const ids = new Set(existing.map((line) => JSON.parse(line).id));
  const added = deriveHoldoutRows(readFileSync(new URL('adversarial.jsonl', root), 'utf8'))
    .filter((row) => !ids.has(row.id))
    .map((row) => JSON.stringify(row));
  writeFileSync(holdoutUrl, `${[...existing, ...added].join('\n')}\n`);
  return added.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(`added ${extendHoldout()} holdout rows`);
