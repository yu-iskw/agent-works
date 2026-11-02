import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const matrixJsonPath = 'docs/plans/enterprise-production-v1/fnd-01/readiness-matrix.json';
export const matrixMdPath = 'docs/plans/enterprise-production-v1/fnd-01/readiness-matrix.md';

const cell = (value) => String(value).replaceAll('|', '\\|');
const table = (header, rows) =>
  [header, header.map(() => '---'), ...rows]
    .map((r) => `| ${r.map(cell).join(' | ')} |`)
    .join('\n');

export async function renderMatrix(matrix) {
  const decisions = matrix.decisions.map((d) => [
    d.id,
    d.question,
    d.ownerRole,
    d.status,
    d.blocksUnrestrictedProduction ? 'yes' : 'no',
    d.blockingCapability,
    d.openItems.join(', ') || 'none',
    d.note,
  ]);
  const openItems = matrix.openItems.map((o) => [
    o.id,
    o.decision,
    o.ownerRole,
    o.status,
    o.blockingCapability,
    o.relatedDecisions.join(', '),
  ]);
  const adrs = matrix.adrs.map((a) => [a.id, a.file, a.status]);
  const markdown = `${[
    '<!-- Generated from readiness-matrix.json by scripts/fnd-01/render-readiness-matrix.mjs. Do not edit. -->',
    `# FND-01 governance readiness matrix`,
    `Recorded ${matrix.recordedOn} on base \`${matrix.baseSha}\`. This file approves nothing.`,
    `## Rule\n\n${matrix.rule}`,
    `## ADRs\n\n${table(['Id', 'File', 'Status'], adrs)}`,
    `## Issue #23 (${matrix.issue23.title}, ${matrix.issue23.state})\n\n${matrix.issue23.finding}`,
    `## Decisions\n\n${table(['Id', 'Question', 'Owner role', 'Status', 'Blocks prod', 'Blocking capability', 'Open items', 'Note'], decisions)}`,
    `## Open items\n\n${table(['Id', 'Open decision', 'Owner role', 'Status', 'Blocking capability', 'Related D'], openItems)}`,
  ].join('\n\n')}\n`;
  const options = await resolveConfig(join(repoRoot, matrixMdPath));
  return format(markdown, { ...options, parser: 'markdown' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const matrix = JSON.parse(readFileSync(join(repoRoot, matrixJsonPath), 'utf8'));
  writeFileSync(join(repoRoot, matrixMdPath), await renderMatrix(matrix));
}
