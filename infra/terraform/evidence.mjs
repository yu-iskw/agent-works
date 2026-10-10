import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { writePng } from '../../e2e/png.mjs';
import { appendResult } from '../../e2e/results.mjs';

const devRoot = 'infra/terraform/environments/dev';
const scratchFile = `${devRoot}/zz-scratch.tf`;

export const evidence = [
  {
    id: 'infra.no-owner-binding',
    scratch: [
      'resource "google_project_iam_member" "scratch_owner" {',
      '  project = "scratch"',
      '  role    = "roles/owner"',
      '  member  = "serviceAccount:scratch@scratch.iam.gserviceaccount.com"',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'infra.no-sa-keys',
    scratch: [
      'resource "google_service_account_key" "scratch" {',
      '  service_account_id = "scratch"',
      '}',
      '',
    ].join('\n'),
  },
];

export function runLabel(id) {
  return id.replaceAll('.', '-');
}

export function parseRuns(jsonLines) {
  const runs = new Map();
  for (const line of jsonLines.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'test_run' && event.test_run?.status) {
      runs.set(event.test_run.run, event.test_run.status);
    }
  }
  return runs;
}

export function judge({ baseline, controlled }) {
  return evidence.map(({ id }) => {
    const reasons = [];
    const label = runLabel(id);
    if (baseline.code !== 0) reasons.push(`committed tree exited ${baseline.code}`);
    if (baseline.runs.get(label) !== 'pass') {
      reasons.push(`committed tree: ${label} is ${baseline.runs.get(label) ?? 'missing'}`);
    }
    const control = controlled.get(id);
    if (control.code === 0) reasons.push('scratch did not fail terraform test');
    if (control.runs.get(label) !== 'fail') {
      reasons.push(`scratch: ${label} is ${control.runs.get(label) ?? 'missing'}, not fail`);
    }
    for (const other of evidence.filter((entry) => entry.id !== id)) {
      const otherLabel = runLabel(other.id);
      if (control.runs.get(otherLabel) !== 'pass') {
        reasons.push(
          `scratch: ${otherLabel} is ${control.runs.get(otherLabel) ?? 'missing'}, not pass`,
        );
      }
    }
    return { id, status: reasons.length === 0 ? 'passed' : 'failed', reasons };
  });
}

function terraformTest() {
  const result = spawnSync('terraform', [`-chdir=${devRoot}`, 'test', '-json', '-no-color'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? 1, runs: parseRuns(result.stdout) };
}

function testWithScratch(body) {
  if (existsSync(scratchFile)) throw new Error(`${scratchFile} already exists`);
  writeFileSync(scratchFile, body);
  try {
    return terraformTest();
  } finally {
    rmSync(scratchFile, { force: true });
  }
}

function main() {
  const baseline = terraformTest();
  const controlled = new Map(evidence.map(({ id, scratch }) => [id, testWithScratch(scratch)]));
  const verdicts = judge({ baseline, controlled });
  for (const { id, status, reasons } of verdicts) {
    writePng(`e2e/artifacts/${id}/${runLabel(id)}.png`, status);
    appendResult({ id, status });
    console.log(`${id}: ${status}`);
    for (const reason of reasons) console.error(`  ${reason}`);
  }
  if (verdicts.some(({ status }) => status !== 'passed')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
