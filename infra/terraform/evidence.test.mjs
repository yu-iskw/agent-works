import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { identityViolations, terraformFiles, judge, parseRuns } from './evidence.mjs';

const run = (name, status) =>
  JSON.stringify({
    type: 'test_run',
    test_run: { path: 'tests/dev.tftest.hcl', run: name, status },
  });

const green = {
  code: 0,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'pass'), run('infra-no-sa-keys', 'pass')].join('\n'),
  ),
};

const controlled = (owner, keys) =>
  new Map([
    [
      'infra.no-owner-binding',
      [
        { where: 'root', ...owner },
        { where: 'module', ...owner },
      ],
    ],
    [
      'infra.no-sa-keys',
      [
        { where: 'root', ...keys },
        { where: 'module', ...keys },
      ],
    ],
  ]);

const ownerTripped = {
  code: 1,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'fail'), run('infra-no-sa-keys', 'pass')].join('\n'),
  ),
};
const keysTripped = {
  code: 1,
  runs: parseRuns(
    [run('infra-no-owner-binding', 'pass'), run('infra-no-sa-keys', 'fail')].join('\n'),
  ),
};

test('parseRuns keeps run statuses and skips progress lines and noise', () => {
  const lines = [
    'not json',
    JSON.stringify({ type: 'test_run', test_run: { run: 'a', progress: 'starting' } }),
    run('a', 'pass'),
    run('b', 'fail'),
  ].join('\n');
  assert.deepEqual(
    [...parseRuns(lines)],
    [
      ['a', 'pass'],
      ['b', 'fail'],
    ],
  );
});

test('each scratch failing only its own run marks both evidence ids passed', () => {
  assert.deepEqual(judge({ baseline: green, controlled: controlled(ownerTripped, keysTripped) }), [
    { id: 'infra.no-owner-binding', status: 'passed', reasons: [] },
    { id: 'infra.no-sa-keys', status: 'passed', reasons: [] },
  ]);
});

test('a scratch that the test does not catch marks that id failed', () => {
  const uncaught = { code: 0, runs: green.runs };
  const verdicts = judge({ baseline: green, controlled: controlled(ownerTripped, uncaught) });
  assert.deepEqual(verdicts[1], {
    id: 'infra.no-sa-keys',
    status: 'failed',
    reasons: [
      'root: scratch did not fail terraform test',
      'root: infra-no-sa-keys is pass, not fail',
      'module: scratch did not fail terraform test',
      'module: infra-no-sa-keys is pass, not fail',
    ],
  });
});

test('a run missing from the committed tree marks its id failed', () => {
  const missing = { code: 0, runs: parseRuns(run('infra-no-owner-binding', 'pass')) };
  const verdicts = judge({ baseline: missing, controlled: controlled(ownerTripped, keysTripped) });
  assert.deepEqual(
    verdicts.map(({ id, status }) => [id, status]),
    [
      ['infra.no-owner-binding', 'passed'],
      ['infra.no-sa-keys', 'failed'],
    ],
  );
});

test('no identities in modules and no keys in any Terraform source', () => {
  assert.deepEqual(identityViolations(), []);
});

test('negative control injects an unexported identity into a temporary module', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-identity-'));
  try {
    const module = join(root, 'modules', 'negative');
    mkdirSync(module, { recursive: true });
    writeFileSync(join(module, 'main.tf'), 'resource "google_service_account" "unexpected" {}');
    assert.match(identityViolations(root)[0], /identity resource in module/);
    writeFileSync(
      join(module, 'main.tf'),
      'resource "google_service_account' + '_key" "unexpected" {}',
    );
    assert.equal(identityViolations(root).length, 2);
    rmSync(join(module, 'main.tf'));
    writeFileSync(
      join(module, 'main.tf.json'),
      JSON.stringify({ resource: { google_service_account: { unexpected: {} } } }),
    );
    assert.match(identityViolations(root)[0], /JSON identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identity creation is confined to the approved roots', () => {
  for (const path of terraformFiles('infra/terraform')) {
    if (/resource\s+"google_service_account"/.test(readFileSync(path, 'utf8'))) {
      assert.match(path, /^infra\/terraform\/(bootstrap|identity\/dev)\//);
    }
  }
});

test('root providers, state backend and remote state all impersonate', () => {
  for (const root of ['identity/dev', 'environments/dev']) {
    const provider = readFileSync(`infra/terraform/${root}/providers.tf`, 'utf8');
    assert.match(provider, /impersonate_service_account\s*=\s*var.terraform_service_account/);
    const backend = readFileSync(`infra/terraform/${root}/backend.tf`, 'utf8');
    assert.match(backend, /backend "gcs"/);
    assert.match(backend, /impersonate_service_account\s*=/);
  }
  assert.match(
    readFileSync('infra/terraform/environments/dev/main.tf', 'utf8'),
    /impersonate_service_account\s*=\s*var.terraform_service_account/,
  );
});

test('every root/module has pinned versions, an interface, IAM evidence and plan-only mocked tests', () => {
  const roots = ['bootstrap', 'identity/dev', 'environments/dev'];
  const modules = [
    'project_baseline',
    'budget',
    'project_iam',
    'artifact_registry',
    'secrets',
    'cloud_run_service',
    'iap_access',
    'github_wif',
    'workflows',
    'scheduler_job',
    'kms',
    'cloud_sql',
    'network',
    'bigquery_analytics',
  ];
  for (const path of [...roots, ...modules.map((name) => `modules/${name}`)]) {
    const dir = `infra/terraform/${path}`;
    const version = readFileSync(`${dir}/versions.tf`, 'utf8');
    assert.match(version, />= 1\.16\.5, < 1\.17\.0/);
    assert.match(version, /version\s*=\s*"8\.5\.0"/);
    assert.doesNotMatch(version, /google-beta/);
    assert.match(readFileSync(`${dir}/outputs.tf`, 'utf8'), /output "iam_bindings"/);
    assert.match(
      readFileSync(`${dir}/tests/contracts.tftest.hcl`, 'utf8'),
      /mock_provider "google"/,
    );
    const tests = readFileSync(`${dir}/tests/contracts.tftest.hcl`, 'utf8');
    assert.doesNotMatch(tests, /command\s*=\s*apply/);
    assert.equal(
      (tests.match(/run "/g) ?? []).length,
      (tests.match(/command\s*=\s*plan/g) ?? []).length,
    );
  }
});

test('plan workflow is inert, keyless and never applies', () => {
  const workflow = readFileSync('.github/workflows/infra-plan.yml', 'utf8');
  assert.match(workflow, /if:.*vars\.TF_PLAN_WIF_PROVIDER != ''/);
  assert.match(workflow, /vars\.TF_PLAN_SA != ''/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /google-github-actions\/auth@[a-f0-9]{40}/);
  assert.match(workflow, /plan -lock=false -input=false/);
  assert.doesNotMatch(workflow, /terraform[^\n]*\bapply\b|credentials_json|secrets\./);
});

test('every provider and GCS backend impersonates, including additional blocks', () => {
  for (const path of terraformFiles('infra/terraform')) {
    const source = readFileSync(path, 'utf8');
    for (const [block] of source.matchAll(/provider\s+"google"\s*\{[^}]*\}/g)) {
      if (!path.startsWith('infra/terraform/bootstrap/')) {
        assert.match(block, /impersonate_service_account\s*=/, path);
      }
    }
    for (const [block] of source.matchAll(/backend\s+"gcs"\s*\{[^}]*\}/g)) {
      assert.match(block, /impersonate_service_account\s*=/, path);
    }
    for (const [, moduleSource] of source.matchAll(/^\s*source\s*=\s*"([^"]+)"/gm)) {
      assert.match(moduleSource, /^(\.\.?\/|hashicorp\/google$)/, path);
    }
  }
});

test('tracked tfvars examples and the bootstrap runbook carry placeholder project ids only', () => {
  const examples = ['bootstrap', 'identity/dev', 'environments/dev'].map(
    (root) => `infra/terraform/${root}/terraform.tfvars.example`,
  );
  for (const path of examples) {
    assert.match(readFileSync(path, 'utf8'), /^project_id\s*=\s*"PROJECT_ID"/m, path);
  }
  const runbook = readFileSync('docs/runbooks/terraform-bootstrap.md', 'utf8');
  assert.doesNotMatch(runbook, /ubie-[a-z0-9-]+/);
});
