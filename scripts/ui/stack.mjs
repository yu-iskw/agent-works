// Shared facts and Docker helpers for the UI milestone commands (scripts/ui/run.mjs).
// The UI milestone runs on the M1 mock stack, Compose project `aw-m1-local`, whose Postgres volumes
// hold the persistent model ledger. Nothing here creates another project or touches volumes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UI = Object.freeze({
  project: 'aw-m1-local',
  port: '8281',
  campaign: 'ui-2026-10',
  callsPerSegment: '300',
  concurrency: '2',
  modelId: 'gemini-3.8-flash',
  llmMode: 'vertex',
});

export const SEGMENTS = ['alpha', 'beta'];
export const artifacts = 'artifacts/ui';
export const compose = ['compose', '-f', 'compose.m1.yaml', '-p', UI.project];

export const appServices = [
  'builder',
  'keys-init',
  'pg-web',
  'pg-alpha',
  'pg-beta',
  'api-alpha',
  'api-beta',
  'web',
];

/** Host path of Application Default Credentials. Only its existence is ever checked. */
export const adcPath = join(
  process.env.GCLOUD_CONFIG_DIR ?? join(homedir(), '.config/gcloud'),
  'application_default_credentials.json',
);

/**
 * The one environment every UI command passes to Compose: M1 local-test (mock identity, fixture
 * sources, faults on) plus the UI campaign. LLM_MODE is pinned to vertex; a scripted or disabled
 * model is refused before any Compose call so nothing can downgrade acceptance.
 */
function uiEnv() {
  const requested = process.env.AW_M1_LLM_MODE;
  if (requested !== undefined && requested !== UI.llmMode) {
    process.stderr.write(
      `UI commands refuse AW_M1_LLM_MODE=${requested}. Acceptance runs on the real model only; unset it.\n`,
    );
    process.exit(2);
  }
  // No secrets directory is mounted on the mock stack, so point the bind at an empty directory.
  const empty = join(process.env.TMPDIR ?? '/tmp', 'aw-m1-no-secrets');
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(empty, 'e2e-session.secret'), '');
  return {
    ...process.env,
    HOST_UID: String(process.getuid?.() ?? 1000),
    HOST_GID: String(process.getgid?.() ?? 1000),
    BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(process.env.TMPDIR ?? '/tmp', 'buildx'),
    AW_M1_SECRETS_DIR: empty,
    AW_M1_PORT: UI.port,
    AW_M1_IDENTITY: 'local-test',
    AW_M1_SOURCE_MODE: 'fixture',
    AW_M1_FIXTURE_FAULTS: '1',
    AW_M1_E2E_MODE: '0',
    AW_M1_LLM_MODE: UI.llmMode,
    AW_M1_MODEL_CAMPAIGN: UI.campaign,
    AW_M1_MAX_MODEL_CALLS_PER_SEGMENT: UI.callsPerSegment,
    AW_M1_CONCURRENCY: UI.concurrency,
  };
}

export function docker(args, options = {}) {
  if (!options.quiet) process.stdout.write(`$ docker ${args.join(' ')}\n`);
  const result = spawnSync('docker', args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    env: uiEnv(),
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

const quiet = { capture: true, quiet: true };

export function report(name, data) {
  mkdirSync(artifacts, { recursive: true });
  const file = join(artifacts, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2)}\n`);
  return file;
}

export function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

export function toolbox(command) {
  return (
    docker([
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      'NODE_OPTIONS=--max-old-space-size=4096',
      'toolbox',
      'sh',
      '-c',
      command,
    ]).status ?? 1
  );
}

/** Playwright inside the `e2e` service against e2e/ui; `vars` become container env. */
export function playwright(project, vars = {}) {
  if (toolbox('pnpm install --frozen-lockfile >/dev/null') !== 0) return 1;
  return (
    docker([
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      `UI_SUITE=${project}`,
      ...Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
      'e2e',
      'node_modules/.bin/playwright',
      'test',
      '-c',
      'e2e/ui',
      `--project=${project}`,
    ]).status ?? 1
  );
}

/** Expanded Compose model for the UI env, or undefined when the file does not validate. */
export function composeConfig() {
  const result = docker([...compose, 'config', '--format', 'json'], quiet);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

/** Running container id for a service of this project, or undefined when it is not up. */
export function containerId(service) {
  const result = docker([...compose, 'ps', '-q', '--status', 'running', service], quiet);
  const id = result.stdout.trim().split('\n')[0];
  return result.status === 0 && id ? id : undefined;
}

function containerEnv(id) {
  const result = docker(['inspect', id, '--format', '{{json .Config.Env}}'], quiet);
  if (result.status !== 0) return {};
  const env = {};
  for (const entry of JSON.parse(result.stdout)) {
    const at = entry.indexOf('=');
    env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

/** Whether the ADC file the container was told to use exists there. Never reads the file. */
function adcInContainer(id) {
  const result = docker(
    [
      'exec',
      id,
      'node',
      '-e',
      "process.exit(require('fs').existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '') ? 0 : 1)",
    ],
    quiet,
  );
  return result.status === 0;
}

/**
 * Campaign usage from a segment's running database. `missingMigration` when migration 0020 has
 * not reached that database yet, which is the case until `ui:up` has run on this branch.
 */
export function ledger(segment) {
  const sql = `select coalesce((select count(*) from wb_model_calls where mode = 'vertex' and sent and campaign = '${UI.campaign}'), 0), coalesce((select outcome from wb_model_calls where segment = '${segment}' and outcome <> 'pending' order by id desc limit 1), 'none')`;
  const result = docker(
    [...compose, 'exec', '-T', `pg-${segment}`, 'psql', '-U', 'postgres', '-At', '-c', sql],
    quiet,
  );
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    return stderr.includes('column "campaign" does not exist')
      ? { state: 'missingMigration' }
      : { state: 'unavailable', detail: stderr.trim().split('\n').at(-1) ?? '' };
  }
  const [used, lastOutcome] = result.stdout.trim().split('|');
  return {
    state: 'ok',
    used: Number(used),
    remaining: Number(UI.callsPerSegment) - Number(used),
    cap: Number(UI.callsPerSegment),
    lastOutcome,
  };
}

/** Text shown next to a model error code, for the doctor and the troubleshooting table. */
export const REMEDIATION = Object.freeze({
  adc_unavailable:
    'Application Default Credentials are missing or expired. Run `gcloud auth application-default login` on the host, then `pnpm ui:up`.',
  api_disabled:
    'The Vertex AI API is disabled. Enable aiplatform.googleapis.com on the configured project.',
  permission_denied:
    'The ADC identity lacks Vertex AI access. Grant roles/aiplatform.user on the configured project.',
  rate_limited:
    'Vertex AI quota or rate limit reached. Wait, then retry; retries count against the campaign.',
  timeout: 'The model call timed out. Retry the task; the retry counts against the campaign.',
  model_not_found:
    'The configured VERTEX_MODEL_ID is not served in this project and location. Changing the model is a decision for the operator, never automatic.',
  budget_exhausted:
    'The campaign cap is reached. Raising it is a decision for the operator, never automatic.',
});

/**
 * The real-model prerequisites, read from the running containers: both segment APIs up with
 * LLM_MODE=vertex, the requested model, the UI campaign and an ADC file in place. Browser suites
 * refuse to start when any of these fails, so a scripted or unconfigured stack cannot produce evidence.
 */
export function preflight() {
  const checks = [];
  const facts = {};
  for (const segment of SEGMENTS) {
    const service = `api-${segment}`;
    const id = containerId(service);
    if (id === undefined) {
      checks.push({
        name: `${service} running`,
        status: 'FAIL',
        detail: 'not running',
        remediation: 'pnpm ui:up',
      });
      continue;
    }
    const env = containerEnv(id);
    const wanted = {
      LLM_MODE: UI.llmMode,
      VERTEX_MODEL_ID: UI.modelId,
      AW_MODEL_CAMPAIGN: UI.campaign,
      AW_IDENTITY: 'local-test',
      AW_SOURCE_MODE: 'fixture',
    };
    for (const [key, value] of Object.entries(wanted)) {
      checks.push({
        name: `${service} ${key}`,
        status: env[key] === value ? 'PASS' : 'FAIL',
        detail: env[key] ?? 'unset',
        ...(env[key] === value
          ? {}
          : { remediation: `expected ${value}; rebuild with pnpm ui:up` }),
      });
    }
    const adc = adcInContainer(id);
    checks.push({
      name: `${service} ADC file mounted`,
      status: adc ? 'PASS' : 'FAIL',
      detail: adc ? 'present' : 'missing',
      ...(adc ? {} : { remediation: REMEDIATION.adc_unavailable }),
    });
    facts[segment] = {
      llmMode: env.LLM_MODE ?? null,
      modelId: env.VERTEX_MODEL_ID ?? null,
      campaign: env.AW_MODEL_CAMPAIGN ?? null,
      project: env.GOOGLE_CLOUD_PROJECT ?? null,
      location: env.GOOGLE_CLOUD_LOCATION ?? null,
      identity: env.AW_IDENTITY ?? null,
      sourceMode: env.AW_SOURCE_MODE ?? null,
      callsCap: env.AW_MAX_MODEL_CALLS ?? null,
      concurrency: env.AW_WORKER_CONCURRENCY ?? null,
    };
  }
  return { ok: checks.every((check) => check.status === 'PASS'), checks, facts };
}

export function printChecks(checks) {
  for (const check of checks) {
    process.stdout.write(
      `${check.status.padEnd(4)}  ${check.name}${check.detail ? `: ${check.detail}` : ''}${check.remediation ? `\n      fix: ${check.remediation}` : ''}\n`,
    );
  }
}
