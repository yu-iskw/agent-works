import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { writePng } from '../e2e/png.mjs';

export const PLAN_ISSUES = {
  'H0-01': 3,
  'H0-02': 4,
  'H0-03': 5,
  'H0-04': 6,
  'H0-05': 7,
  'F1-01': 8,
  'F1-02': 9,
  'F1-03': 10,
  'F1-04': 11,
  'F1-05': 12,
  'F1-06': 13,
  'F2-01': 14,
  'F2-02': 15,
  'F2-03': 16,
  'F2-04': 17,
  'F2-05': 18,
  'C-01': 19,
  'C-02': 20,
  'C-03': 21,
  'C-04': 22,
  'C-05': 23,
  'C-06': 24,
  'C-07': 25,
};

export function parseControls(text) {
  const normalized = text.startsWith('- id:') ? `\n${text}` : text;
  return normalized
    .split('\n- id: ')
    .slice(1)
    .map((block) => {
      const lines = block.split('\n');
      const control = { id: lines[0].trim(), kind: '', test: '', owner: '' };
      for (const line of lines.slice(1)) {
        const match = /^  (kind|test|owner): (\S*)\s*$/.exec(line);
        if (match) control[match[1]] = match[2];
      }
      return control;
    });
}

export function checkPending({ pending, controls, openPlans }) {
  const failures = [];
  for (const row of pending) {
    if (!row.owner) {
      failures.push(`${row.id} has no owner`);
      continue;
    }
    if (!Object.hasOwn(PLAN_ISSUES, row.owner)) {
      failures.push(`${row.id} owner ${row.owner} is unknown`);
      continue;
    }
    if (!openPlans.has(row.owner)) failures.push(`${row.id} owner ${row.owner} is merged`);
  }
  for (const control of controls) {
    if (!control.test) failures.push(`${control.id} has no test id`);
  }
  return failures;
}

function openPlansFromGitHub() {
  const raw = execFileSync(
    'gh',
    [
      'issue',
      'list',
      '--repo',
      'yu-iskw/agent-works',
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,state',
    ],
    { encoding: 'utf8' },
  );
  const byNumber = new Map(
    JSON.parse(raw).map((issue) => [issue.number, String(issue.state).toUpperCase()]),
  );
  const open = new Set();
  for (const [planId, number] of Object.entries(PLAN_ISSUES)) {
    if (byNumber.get(number) === 'OPEN') open.add(planId);
  }
  return open;
}

function main() {
  const pending = JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8'));
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const failures = checkPending({
    pending,
    controls,
    openPlans: openPlansFromGitHub(),
  });
  const passed = failures.length === 0;
  writePng('e2e/artifacts/pending.all-owned/pending-all-owned.png', passed ? 'passed' : 'failed');
  writeFileSync(
    'e2e/artifacts/results.json',
    `${JSON.stringify(
      { tests: [{ id: 'pending.all-owned', status: passed ? 'passed' : 'failed' }] },
      null,
      2,
    )}\n`,
  );
  if (!passed) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
