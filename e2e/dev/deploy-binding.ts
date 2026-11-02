import { readFileSync } from 'node:fs';

import type { TestInfo } from '@playwright/test';

type DeployedService = {
  readonly image: string;
  readonly digest: string;
  readonly revision: string;
  readonly url: string | undefined;
};

/** The approved SHA and digests the dev suite is allowed to run against. */
export type DeployBinding = {
  readonly commitSha: string;
  readonly approvalRef: string;
  readonly web: DeployedService;
  readonly api: DeployedService;
};

type Env = Readonly<Record<string, string | undefined>>;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`deploy summary ${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(source: Record<string, unknown>, key: string): unknown {
  return Object.entries(source).find(([name]) => name === key)?.[1];
}

function text(source: Record<string, unknown>, key: string, what: string): string {
  const value = field(source, key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`deploy summary ${what}.${key} must be a non-empty string`);
  }
  return value;
}

function service(summary: Record<string, unknown>, name: 'aw-web' | 'aw-api'): DeployedService {
  const source = record(field(record(summary.services, 'services'), name), `services.${name}`);
  const image = text(source, 'image', name);
  const digest = text(source, 'digest', name);
  if (!DIGEST.test(digest) || !image.endsWith(`@${digest}`) || image.includes(':latest')) {
    throw new Error(`deploy summary ${name} image must be pinned by the recorded sha256 digest`);
  }
  const url = typeof source.url === 'string' && source.url.length > 0 ? source.url : undefined;
  return { image, digest, revision: text(source, 'revision', name), url };
}

/**
 * Parses the deploy-summary.json the Deploy Dev workflow uploads and checks it
 * is the deployment the operator approved. Without it the dev suite cannot
 * claim to have run against a specific digest.
 */
function parseDeployBinding(raw: string, approvedSha: string): DeployBinding {
  if (!SHA.test(approvedSha)) {
    throw new Error('AW_DEV_EXPECTED_SHA must be the approved 40-char lowercase hex commit SHA');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AW_DEV_DEPLOY_SUMMARY is not valid JSON');
  }
  const summary = record(parsed, 'root');
  if (summary.environment !== 'dev') throw new Error("deploy summary environment must be 'dev'");
  const commitSha = text(summary, 'commitSha', 'root');
  if (commitSha !== approvedSha) {
    throw new Error('deploy summary commitSha does not match AW_DEV_EXPECTED_SHA');
  }
  return {
    commitSha,
    approvalRef: text(summary, 'approvalRef', 'root'),
    web: service(summary, 'aw-web'),
    api: service(summary, 'aw-api'),
  };
}

export function loadDeployBinding(env: Env): DeployBinding {
  const path = env.AW_DEV_DEPLOY_SUMMARY?.trim() ?? '';
  if (path.length === 0) {
    throw new Error(
      'AW_DEV_DEPLOY_SUMMARY is required: path to the deploy-summary.json of the approved deployment',
    );
  }
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied summary path
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error('AW_DEV_DEPLOY_SUMMARY could not be read');
  }
  return parseDeployBinding(raw, env.AW_DEV_EXPECTED_SHA?.trim() ?? '');
}

export async function attachDeployBinding(testInfo: TestInfo, env: Env): Promise<DeployBinding> {
  const binding = loadDeployBinding(env);
  await testInfo.attach('deploy-binding.json', {
    body: JSON.stringify(binding, null, 2),
    contentType: 'application/json',
  });
  return binding;
}
