import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { writePng } from '../e2e/png.mjs';

export function parseControls(text) {
  return `\n${text}`
    .split('\n- id: ')
    .slice(1)
    .map((block) => {
      const lines = block.split('\n');
      const control = { id: lines[0].trim(), test: '', owner: '' };
      for (const line of lines.slice(1)) {
        const match = /^  (test|owner): (\S*)\s*$/.exec(line);
        if (match) control[match[1]] = match[2];
      }
      return control;
    });
}

export function checkPending({ pending, controls, plans }) {
  const failures = [];
  const byId = new Map(pending.map((row) => [row.id, row]));
  for (const row of pending) {
    if (!row.owner) {
      failures.push(`${row.id} has no owner`);
      continue;
    }
    const state = plans.get(row.owner);
    if (!state) {
      failures.push(`${row.id} owner ${row.owner} is unknown`);
      continue;
    }
    if (state !== 'OPEN') failures.push(`${row.id} owner ${row.owner} is merged`);
  }
  for (const control of controls) {
    if (!control.test) {
      failures.push(`${control.id} has no test id`);
      continue;
    }
    if (!control.owner) {
      failures.push(`${control.id} has no owner`);
      continue;
    }
    const row = byId.get(control.test);
    if (row && control.owner !== row.owner) {
      failures.push(`${control.id} owner ${control.owner} does not match ${row.owner}`);
    }
  }
  return failures;
}

function plansFromGitHub() {
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
      'title,state',
    ],
    { encoding: 'utf8' },
  );
  const plans = new Map();
  for (const issue of JSON.parse(raw)) {
    const match = /^([A-Z0-9]+-\d+):/.exec(issue.title);
    if (!match) continue;
    plans.set(match[1], String(issue.state).toUpperCase());
  }
  return plans;
}

function main() {
  const pending = JSON.parse(readFileSync('e2e/security/pending-tests.json', 'utf8'));
  const controls = parseControls(readFileSync('docs/security/controls.yaml', 'utf8'));
  const failures = checkPending({ pending, controls, plans: plansFromGitHub() });
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
