import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateDeployInputs } from './validate-deploy-inputs.mjs';

const project = 'aw-dev-project';
const registry = `asia-northeast1-docker.pkg.dev/${project}/aw-images`;
const digest = (char: string) => `sha256:${char.repeat(64)}`;

const approved = {
  INPUT_ENVIRONMENT: 'dev',
  TF_PROJECT_ID: project,
  DEPLOY_WIF_PROVIDER:
    'projects/123456789012/locations/global/workloadIdentityPools/aw-github/providers/github',
  DEPLOYER_SA: `aw-deployer@${project}.iam.gserviceaccount.com`,
  DEPLOY_SHA: 'a'.repeat(40),
  APPROVAL_REF: 'OPS-APPROVAL-1',
  WEB_IMAGE: `${registry}/aw-web@${digest('b')}`,
  API_IMAGE: `${registry}/aw-api@${digest('c')}`,
};

function errorsFor(overrides: Record<string, string | undefined>): string[] {
  return validateDeployInputs({ ...approved, ...overrides });
}

describe('validateDeployInputs', () => {
  it('accepts an approved SHA with digest-pinned images from the project registry', () => {
    expect(validateDeployInputs(approved)).toEqual([]);
  });

  it.each([
    ['a tag', `${registry}/aw-web:latest`],
    ['a tag plus digest', `${registry}/aw-web:main@${digest('b')}`],
    ['a short digest', `${registry}/aw-web@sha256:${'b'.repeat(63)}`],
    ['an uppercase digest', `${registry}/aw-web@sha256:${'B'.repeat(64)}`],
    ['a foreign registry', `docker.io/library/aw-web@${digest('b')}`],
    [
      'another project',
      `asia-northeast1-docker.pkg.dev/other-project/aw-images/aw-web@${digest('b')}`,
    ],
    ['the api image in the web slot', `${registry}/aw-api@${digest('b')}`],
  ])('rejects web_image as %s', (_label, value) => {
    expect(errorsFor({ WEB_IMAGE: value }).join('\n')).toMatch(/web_image/);
  });

  it('rejects api_image that is not a digest of aw-api', () => {
    expect(errorsFor({ API_IMAGE: `${registry}/aw-api:latest` }).join('\n')).toMatch(/api_image/);
    expect(errorsFor({ API_IMAGE: `${registry}/aw-web@${digest('c')}` }).join('\n')).toMatch(
      /api_image/,
    );
  });

  it.each(['main', 'A'.repeat(40), 'a'.repeat(39), ''])('rejects sha %j', (value) => {
    expect(errorsFor({ DEPLOY_SHA: value }).join('\n')).toMatch(/sha/);
  });

  it.each([undefined, '', 'x', '<approval-ref>', 'TODO'])('rejects approval_ref %j', (value) => {
    expect(errorsFor({ APPROVAL_REF: value }).join('\n')).toMatch(/approval_ref/);
  });

  it('rejects a non-dev environment, a placeholder project and a foreign deployer', () => {
    expect(errorsFor({ INPUT_ENVIRONMENT: 'prod' }).join('\n')).toMatch(/dev/);
    expect(errorsFor({ TF_PROJECT_ID: '' }).join('\n')).toMatch(/TF_PROJECT_ID/);
    expect(errorsFor({ TF_PROJECT_ID: 'your-project-id' }).join('\n')).toMatch(/TF_PROJECT_ID/);
    expect(errorsFor({ DEPLOYER_SA: 'attacker@other.iam.gserviceaccount.com' }).join('\n')).toMatch(
      /DEPLOYER_SA/,
    );
    expect(errorsFor({ DEPLOY_WIF_PROVIDER: '' }).join('\n')).toMatch(/DEPLOY_WIF_PROVIDER/);
  });

  it('exits non-zero from the CLI the workflow runs, and zero when approved', () => {
    const script = resolve(import.meta.dirname, 'validate-deploy-inputs.mjs');
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    expect(run(approved).status).toBe(0);
    const rejected = run({ ...approved, WEB_IMAGE: `${registry}/aw-web:latest` });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('Refusing deployment');
  });
});

describe('deploy-dev workflow contract', () => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed workflow in the repo
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/deploy-dev.yml'),
    'utf8',
  );

  it('is manual only, keyless, and dev only', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/^ {2}(push|pull_request|schedule):/m);
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('google-github-actions/auth@');
    expect(workflow).not.toMatch(/credentials_json|secrets\./);
    expect(workflow).not.toMatch(/--allow-unauthenticated|--no-iap|--ingress=all/);
    expect(workflow).toContain('environment: dev');
  });

  it('takes the approval reference and runs the tested input validator before deploying', () => {
    expect(workflow).toMatch(/^ {6}approval_ref:/m);
    const validate = workflow.indexOf('node e2e/dev/validate-deploy-inputs.mjs');
    const authenticate = workflow.indexOf('google-github-actions/auth@');
    const update = workflow.indexOf('gcloud run services update');
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(authenticate);
    expect(authenticate).toBeLessThan(update);
  });

  it('proves the digests exist, and checks the guard rails, before any service update', () => {
    const update = workflow.indexOf('gcloud run services update');
    for (const gate of [
      'gcloud artifacts docker images describe',
      'AW_MODE',
      'run.googleapis.com/ingress',
    ]) {
      const at = workflow.indexOf(gate);
      expect(at, gate).toBeGreaterThan(-1);
      expect(at, gate).toBeLessThan(update);
    }
  });

  it('verifies the live revision serves the requested digest and records rollback targets', () => {
    expect(workflow).toContain('previousImages');
    expect(workflow).toContain('approvalRef');
    expect(workflow).toMatch(/serving image .* does not match/);
    expect(workflow).toMatch(/latestRevision/);
  });
});
