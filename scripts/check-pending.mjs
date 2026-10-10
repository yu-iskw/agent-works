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

const ISSUE_PAGE_SIZE = 100;

export function resolveRepository(env, originUrl) {
  const fromActions = env.GITHUB_REPOSITORY?.trim() ?? '';
  const repo = fromActions || ownerRepoFromOrigin(originUrl);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repository must be owner/name');
  return repo;
}

function ownerRepoFromOrigin(url) {
  const trimmed = url.trim();
  const ssh = /^git@github\.com:(.+)$/.exec(trimmed);
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/(.+)$/.exec(trimmed);
  const path = (ssh?.[1] ?? https?.[1] ?? '').replace(/\.git$/, '').replace(/\/$/, '');
  const parts = path.split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error('cannot read owner/repo from origin');
  }
  return `${parts[0]}/${parts[1]}`;
}

export function plansFromIssuePages(readPage) {
  const plans = new Map();
  let page = 1;
  for (;;) {
    const rows = readPage(page);
    for (const issue of rows) {
      if (issue.pull_request != null) continue;
      const match = /^([A-Z0-9]+-\d+):/.exec(issue.title);
      if (!match) continue;
      plans.set(match[1], String(issue.state).toUpperCase());
    }
    if (rows.length < ISSUE_PAGE_SIZE) break;
    page += 1;
  }
  return plans;
}

function fetchIssuePage(repo, page) {
  const raw = execFileSync(
    'gh',
    ['api', `repos/${repo}/issues?state=all&per_page=${ISSUE_PAGE_SIZE}&page=${page}`],
    { encoding: 'utf8' },
  );
  return JSON.parse(raw);
}

function plansFromGitHub() {
  const originUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const repo = resolveRepository(process.env, originUrl);
  return plansFromIssuePages((page) => fetchIssuePage(repo, page));
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
