import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const devRoot = 'infra/terraform/environments/dev';
const scratchTargets = [
  { where: 'root', file: `${devRoot}/zz-scratch.tf` },
  { where: 'module', file: 'infra/terraform/modules/project_iam/zz-scratch.tf' },
];

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
      'resource "google_service_account' + '_key" "scratch" {',
      '  service_account_id = "projects/aw-test-project/serviceAccounts/aw-api@aw-test-project.iam.gserviceaccount.com"',
      '}',
      '',
    ].join('\n'),
  },
];

// Terraform run labels are identifiers, so a dot in an evidence id cannot appear in the label.
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
    const controls = controlled.get(id) ?? [];
    if (controls.length === 0) reasons.push('no scratch run');
    for (const control of controls) {
      const where = control.where;
      if (control.code === 0) reasons.push(`${where}: scratch did not fail terraform test`);
      if (control.runs.get(label) !== 'fail') {
        reasons.push(`${where}: ${label} is ${control.runs.get(label) ?? 'missing'}, not fail`);
      }
      for (const other of evidence.filter((entry) => entry.id !== id)) {
        const otherLabel = runLabel(other.id);
        if (control.runs.get(otherLabel) !== 'pass') {
          reasons.push(
            `${where}: ${otherLabel} is ${control.runs.get(otherLabel) ?? 'missing'}, not pass`,
          );
        }
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

function testWithScratch(file, body) {
  if (existsSync(file)) throw new Error(`${file} already exists`);
  writeFileSync(file, body);
  try {
    return terraformTest();
  } finally {
    rmSync(file, { force: true });
  }
}

function main() {
  const baseline = terraformTest();
  const controlled = new Map(
    evidence.map(({ id, scratch }) => [
      id,
      scratchTargets.map(({ where, file }) => ({ where, ...testWithScratch(file, scratch) })),
    ]),
  );
  const verdicts = judge({ baseline, controlled });
  for (const { id, status, reasons } of verdicts) {
    console.log(`${id}: ${status}`);
    for (const reason of reasons) console.error(`  ${reason}`);
  }
  mkdirSync('infra/terraform/evidence-artifacts', { recursive: true });
  writeFileSync(
    'infra/terraform/evidence-artifacts/results.json',
    JSON.stringify(verdicts, null, 2),
  );
  if (verdicts.some(({ status }) => status !== 'passed')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// Source scans are independent of credentials, provider installation and planned
// output maps: an unexported resource still trips the negative control.
export function terraformFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.terraform' || entry.name === 'evidence-artifacts') return [];
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? terraformFiles(path)
      : /\.tf(?:\.json)?$/.test(entry.name)
        ? [path]
        : [];
  });
}
export function identityViolations(root = 'infra/terraform') {
  return terraformFiles(root).flatMap((path) => {
    const source = readFileSync(path, 'utf8');
    const type = 'google_service_account';
    const violations = [];
    if (path.includes('/modules/') && new RegExp(`resource\\s+"${type}(?:_key)?"`).test(source)) {
      violations.push(`${path}: identity resource in module`);
    }
    if (source.includes(type + '_key')) violations.push(`${path}: key resource`);
    // JSON Terraform syntax must not provide a bypass.
    if (path.endsWith('.tf.json')) {
      const resources = JSON.parse(source).resource ?? {};
      if (path.includes('/modules/') && Object.hasOwn(resources, type))
        violations.push(`${path}: JSON identity in module`);
    }
    return violations;
  });
}
