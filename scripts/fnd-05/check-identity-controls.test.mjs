import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkIdentityControls,
  scanCredentialText,
  scanFiles,
  scanPublicInvocationText,
} from './check-identity-controls.mjs';

const keyField = `"${'private'}_key"`;
const pemHeader = `-----BEGIN ${'PRIVATE'} KEY-----`;
const publicUsers = ['all', 'Users'].join('');
const publicAuthenticated = ['all', 'AuthenticatedUsers'].join('');

describe('static key detection', () => {
  it.each([
    ['key JSON field', `{ ${keyField}: "x" }`],
    ['PEM header', `${pemHeader}\nabc`],
    ['key file type', '{ "type": "service_account" }'],
    ['key resource', 'resource "google_service_account_key" "k" {}'],
  ])('flags %s', (_name, text) => {
    expect(scanCredentialText('a.json', text)).toHaveLength(1);
  });

  it('passes ordinary configuration and secret references', () => {
    const text = 'secret_env = { TOKEN = { secret_id = "token", version = "3" } }';
    expect(scanCredentialText('a.tf', text)).toEqual([]);
  });
});

describe('public invocation detection', () => {
  it.each([publicUsers, publicAuthenticated])('flags %s in terraform', (member) => {
    const text = `resource "x" "y" {\n  role = "roles/run.invoker"\n  member = "${member}"\n}`;
    expect(scanPublicInvocationText('m.tf', text)).toHaveLength(1);
  });

  it('ignores commented terraform lines', () => {
    expect(scanPublicInvocationText('m.tf', `# never ${publicUsers}`)).toEqual([]);
  });

  it('flags a plan json invoker binding with a public member', () => {
    const plan = {
      resource_changes: [{ change: { after: { role: 'roles/run.invoker', member: publicUsers } } }],
    };
    expect(scanPublicInvocationText('plan.json', JSON.stringify(plan))).toHaveLength(1);
  });

  it('flags a plan json invoker binding with a public members list', () => {
    const plan = {
      bindings: [
        {
          role: 'roles/run.invoker',
          members: [`serviceAccount:a@b.iam.gserviceaccount.com`, publicAuthenticated],
        },
      ],
    };
    expect(scanPublicInvocationText('plan.json', JSON.stringify(plan))).toHaveLength(1);
  });

  it('passes a plan with only service account invokers', () => {
    const plan = {
      after: { role: 'roles/run.invoker', member: 'serviceAccount:a@b.iam.gserviceaccount.com' },
    };
    expect(scanPublicInvocationText('plan.json', JSON.stringify(plan))).toEqual([]);
  });

  it('lets an explicitly approved path through', () => {
    const files = [{ path: 'm.tf', text: `member = "${publicUsers}"` }];
    expect(scanFiles(files)).toHaveLength(1);
    expect(scanFiles(files, new Set(['m.tf']))).toEqual([]);
  });
});

describe('tree scan', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), 'fnd05-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
  }

  function put(root, path, text) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }

  it('is clean for a repo without keys or public invokers', () => {
    const root = scratch();
    put(root, 'infra/m.tf', 'member = "serviceAccount:a@b.iam.gserviceaccount.com"');
    execFileSync('git', ['add', '-A'], { cwd: root });
    expect(checkIdentityControls({ repoRoot: root })).toEqual([]);
  });

  it('fails on a tracked key file and on a plan artifact with a public invoker', () => {
    const root = scratch();
    put(root, 'deploy-key.json', `{ ${keyField}: "x" }`);
    execFileSync('git', ['add', '-A'], { cwd: root });
    const planDir = mkdtempSync(join(tmpdir(), 'fnd05-plan-'));
    dirs.push(planDir);
    put(planDir, 'plan.json', JSON.stringify({ role: 'roles/run.invoker', member: publicUsers }));
    const rules = checkIdentityControls({ repoRoot: root, planDirs: [planDir] }).map((f) => f.rule);
    expect(rules.sort()).toEqual(['public-invoker', 'static-key']);
  });

  it('passes on the real repository', () => {
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    expect(checkIdentityControls({ repoRoot })).toEqual([]);
  });
});
