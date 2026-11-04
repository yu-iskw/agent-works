import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const planDir = 'docs/plans/enterprise-production-v1';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Stable JSON: sorted keys, so the same content always digests the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const declared = [
  'VALIDATED',
  'FAILED',
  'BLOCKED',
  'READY_FOR_REVIEW',
  'INTEGRATED',
  'AWAITING_OPERATOR',
  'RUNNING',
  'READY',
  'DRAFT',
];

/**
 * Declared task status from the evidence header. "not VALIDATED" is a denial, not a claim.
 * No declaration is UNSTATED; it is never inferred upward.
 */
export function declaredStatus(text) {
  const lines = text.split(/\r?\n/);
  const scan = (chunk) => {
    const cleaned = chunk.replace(/\bnot\s+(VALIDATED|INTEGRATED)\b/gi, '');
    return declared.find((word) => new RegExp(`\\b${word}\\b`).test(cleaned));
  };
  return scan(lines.slice(0, 12).join('\n')) ?? scan(text) ?? 'UNSTATED';
}

/**
 * Counts result words that start a table cell. Rows whose "Local or live" cell says live are
 * counted apart: a pending live row never changes the local result. Prose mentions are ignored.
 */
export function resultCounts(text) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, UNTESTED: 0, AWAITING_OPERATOR: 0, LIVE_ROWS: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    const word = cells
      .map((cell) => /^\s*\**(PASS|FAIL|BLOCKED|UNTESTED|AWAITING_OPERATOR)\b/.exec(cell)?.[1])
      .find(Boolean);
    if (!word) continue;
    const isLive = word === 'AWAITING_OPERATOR' || cells.some((cell) => /^\s*live\b/i.test(cell));
    if (isLive) counts.LIVE_ROWS += 1;
    else counts[word] += 1;
  }
  return counts;
}

/**
 * Local result for gate math. A FAIL row or FAILED status is FAIL. A BLOCKED or UNTESTED local
 * row is UNTESTED. A declared READY_FOR_REVIEW or later, or an unstated status with passing
 * local rows, is PASS. A missing file is UNTESTED, never PASS.
 */
export function localResult({ status, counts }) {
  if (status === 'FAILED' || counts.FAIL > 0) return 'FAIL';
  if (counts.BLOCKED > 0 || counts.UNTESTED > 0) return 'UNTESTED';
  if (['READY_FOR_REVIEW', 'INTEGRATED', 'AWAITING_OPERATOR', 'VALIDATED'].includes(status))
    return 'PASS';
  return status === 'UNSTATED' && counts.PASS > 0 ? 'PASS' : 'UNTESTED';
}

const operatorText = (line) =>
  line.trimStart().startsWith('|')
    ? line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(' / ')
    : line.trim();

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
}

const awaiting = /AWAITING_OPERATOR/;

/**
 * Scans docs/plans/enterprise-production-v1/<task>/ for every task id. A task without an
 * evidence.md is reported with evidence: null, never invented. `skipDirs` drops a folder's
 * operator lines; `evidenceOnly` reads them from evidence.md alone, so generated files that
 * quote those lines never feed back into their own input.
 */
export function scanTasks(root, taskIds, { skipDirs = [], evidenceOnly = [] } = {}) {
  return taskIds.map((id) => {
    const folder = id.toLowerCase();
    const dir = join(root, planDir, folder);
    const files = existsSync(dir)
      ? walk(dir).map((file) => ({
          path: relative(root, file),
          sha256: sha256(readFileSync(file)),
          bytes: statSync(file).size,
        }))
      : [];
    const evidencePath = `${planDir}/${folder}/evidence.md`;
    const evidence = files.some((file) => file.path === evidencePath);
    const text = evidence ? readFileSync(join(root, evidencePath), 'utf8') : '';
    const status = evidence ? declaredStatus(text) : 'NO_EVIDENCE';
    const counts = resultCounts(text);
    const operatorItems = skipDirs.includes(folder)
      ? []
      : files
          .filter(
            (file) =>
              file.path.endsWith('.md') &&
              (!evidenceOnly.includes(folder) || file.path === evidencePath),
          )
          .flatMap((file) =>
            readFileSync(join(root, file.path), 'utf8')
              .split(/\r?\n/)
              .flatMap((line, index) =>
                awaiting.test(line)
                  ? [{ file: file.path, line: index + 1, text: operatorText(line) }]
                  : [],
              ),
          );
    return {
      id,
      evidence: evidence ? evidencePath : null,
      declaredStatus: status,
      counts,
      local: evidence ? localResult({ status, counts }) : 'UNTESTED',
      claimsValidated: /\bVALIDATED\b/.test(text.replace(/\bnot\s+VALIDATED\b/gi, '')),
      operatorItems,
      files,
    };
  });
}

export function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}
