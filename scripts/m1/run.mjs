#!/usr/bin/env node
// M1 lifecycle and verification. Everything runs in Compose; this host script only orchestrates.
// M1 is mock-only by Yu's decision (2026-10-30): mock identities, fixture sources, mocked Google and
// GitHub, real Vertex. The live stack (--live-stack, e2e live) is kept for a later milestone.
//   node scripts/m1/run.mjs doctor [--vertex] [--live-stack]   prerequisites; --vertex spends 1 call per segment
//   node scripts/m1/run.mjs up [--live-stack]    build, migrate, start both segments, wait for health
//   node scripts/m1/run.mjs down                 stop, keep data
//   node scripts/m1/run.mjs reset --yes-delete-m1-volumes [--live-stack]   delete only that M1 project's volumes
//   node scripts/m1/run.mjs test                 build, typecheck, ESLint, unit and integration tests
//   node scripts/m1/run.mjs e2e [local|live]     browser suites (local: labelled local-test identity)
//   node scripts/m1/run.mjs ux <round>           UI review round (scripted model, no Vertex calls)
//   node scripts/m1/run.mjs restart              kill a segment API mid-assignment, restart everything, verify recovery
//   node scripts/m1/run.mjs evidence [--index-only]   mock-stack journeys with video, plus an evidence index
//   node scripts/m1/run.mjs verify               every M1 machine gate; non-zero on any failure
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Separate Compose projects, so local-test identities and fixtures never share volumes with live
 * data. Each project keeps its own durable call ledger per segment; the caps (live 200 + 200,
 * local-test 100 + 100) sum to the campaign's 600-call limit.
 */
const PROJECTS = {
  live: { name: 'aw-m1', port: '8280' },
  'local-test': { name: 'aw-m1-local', port: '8281' },
  ux: { name: 'aw-m1-ux', port: '8282' },
};
const composeFor = (mode) => ['compose', '-f', 'compose.m1.yaml', '-p', PROJECTS[mode].name];
const compose = composeFor('live');
const artifacts = 'artifacts/m1';
const secretsDir = process.env.AW_M1_SECRETS_DIR ?? join(homedir(), '.config/agent-works-m1');
const appServices = [
  'builder',
  'keys-init',
  'pg-web',
  'pg-alpha',
  'pg-beta',
  'api-alpha',
  'api-beta',
  'web',
];

/**
 * Keys the later-milestone live stack needs (Google sign-in, Drive and Docs); doctor --live-stack
 * reports each as set or missing, never a value. M1 itself needs none of them.
 */
const REQUIRED = [
  'AW_M1_GOOGLE_CLIENT_ID',
  'AW_M1_GOOGLE_CLIENT_SECRET',
  'AW_M1_ALPHA_MEMBERS',
  'AW_M1_BETA_MEMBERS',
  'AW_M1_E2E_SESSION_SECRET',
  'AW_M1_ALPHA_DRIVE_RESEARCH_FOLDER',
  'AW_M1_ALPHA_DRIVE_CONTEXT_FOLDER',
  'AW_M1_BETA_DRIVE_RESEARCH_FOLDER',
  'AW_M1_BETA_DRIVE_CONTEXT_FOLDER',
];

const MODES = {
  live: {
    AW_M1_IDENTITY: 'google',
    AW_M1_SOURCE_MODE: 'live',
    AW_M1_FIXTURE_FAULTS: '0',
    AW_M1_E2E_MODE: '1',
    AW_M1_MAX_MODEL_CALLS_PER_SEGMENT: '200',
  },
  // UI review rounds: scripted model, so a round costs no Vertex calls. Labelled on every page.
  ux: {
    AW_M1_IDENTITY: 'local-test',
    AW_M1_SOURCE_MODE: 'fixture',
    AW_M1_FIXTURE_FAULTS: '1',
    AW_M1_E2E_MODE: '0',
    AW_M1_LLM_MODE: 'scripted',
  },
  'local-test': {
    AW_M1_IDENTITY: 'local-test',
    AW_M1_SOURCE_MODE: 'fixture',
    AW_M1_FIXTURE_FAULTS: '1',
    AW_M1_E2E_MODE: '0',
    AW_M1_MAX_MODEL_CALLS_PER_SEGMENT: '100',
  },
};

const baseEnv = {
  ...process.env,
  HOST_UID: String(process.getuid?.() ?? 1000),
  HOST_GID: String(process.getgid?.() ?? 1000),
  AW_M1_SECRETS_DIR: secretsDir,
  BUILDX_CONFIG: process.env.BUILDX_CONFIG ?? join(process.env.TMPDIR ?? '/tmp', 'buildx'),
};

function docker(args, env = baseEnv, options = {}) {
  if (!options.quiet) process.stdout.write(`$ docker ${args.join(' ')}\n`);
  const result = spawnSync('docker', args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function secretsFile() {
  const file = join(secretsDir, 'm1.env');
  return existsSync(file) ? file : undefined;
}

/** Inside a container, so the host never reads the file: prints only key names that are empty. */
function missingKeys(env) {
  const script = `const fs=require('fs');let body='';try{body=fs.readFileSync('/run/aw-m1/m1.env','utf8')}catch{};const set=new Set(body.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#')&&l.includes('=')&&l.slice(l.indexOf('=')+1).trim()!=='').map(l=>l.slice(0,l.indexOf('=')).trim()));process.stdout.write(JSON.stringify(${JSON.stringify(REQUIRED)}.filter(k=>!set.has(k))))`;
  const result = docker(
    [
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'node',
      'api-alpha',
      '-e',
      script,
    ],
    env,
    { capture: true, quiet: true },
  );
  try {
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '[]');
  } catch {
    return REQUIRED;
  }
}

function report(name, data) {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(
    join(artifacts, `${name}.json`),
    `${JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2)}\n`,
  );
}

function doctor(args) {
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}\n`);
  };
  add(
    'docker daemon',
    docker(['version', '--format', '{{.Server.Version}}'], baseEnv, { capture: true, quiet: true })
      .status === 0,
  );
  add(
    'compose config',
    docker([...composeFor('local-test'), 'config', '--quiet'], currentEnv('local-test'), {
      capture: true,
      quiet: true,
    }).status === 0,
  );
  const adc = join(
    process.env.GCLOUD_CONFIG_DIR ?? join(homedir(), '.config/gcloud'),
    'application_default_credentials.json',
  );
  add(
    'ADC file present',
    existsSync(adc),
    existsSync(adc)
      ? 'run `gcloud auth application-default login` if calls fail with adc_unavailable'
      : 'run `gcloud auth application-default login` on the host',
  );
  if (args.includes('--live-stack')) liveStackChecks(add);
  if (args.includes('--vertex')) {
    for (const segment of ['alpha', 'beta']) {
      const result = docker(
        [
          ...composeFor('local-test'),
          'run',
          '--rm',
          '--no-deps',
          '-T',
          `api-${segment}`,
          'node',
          'apps/api/dist/teamwork/smoke.js',
        ],
        currentEnv('local-test'),
        { capture: true, quiet: true },
      );
      const line = result.stdout.trim().split('\n').at(-1) ?? '';
      add(`vertex smoke (${segment})`, result.status === 0, line);
    }
  }
  report('doctor', { checks });
  return checks.every((check) => check.ok) ? 0 : 1;
}

/** Secrets for the later-milestone live stack; not needed for M1. */
function liveStackChecks(add) {
  const file = secretsFile();
  add(
    'secrets file',
    file !== undefined,
    file === undefined
      ? `create ${join(secretsDir, 'm1.env')} per docs/m1/SETUP_OAUTH.md`
      : join(secretsDir, 'm1.env'),
  );
  if (file !== undefined) {
    const mode = statSync(file).mode & 0o777;
    add('secrets file mode 0600', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
    add(
      'e2e session secret file',
      existsSync(join(secretsDir, 'e2e-session.secret')),
      'see SETUP_OAUTH.md section 4',
    );
    const missing = missingKeys({ ...baseEnv, ...MODES.live });
    add(
      'required keys set',
      missing.length === 0,
      missing.length === 0 ? `${REQUIRED.length} keys` : `missing: ${missing.join(', ')}`,
    );
  }
}

function requireLive() {
  if (secretsFile() === undefined) {
    process.stderr.write(
      `Live mode needs ${join(secretsDir, 'm1.env')} (docs/m1/SETUP_OAUTH.md). Nothing was started. M1 uses the mock stack: pnpm m1:up\n`,
    );
    return false;
  }
  const missing = missingKeys({ ...baseEnv, ...MODES.live });
  if (missing.length > 0) {
    process.stderr.write(
      `Live mode is missing settings: ${missing.join(', ')}. Nothing was started; no fake identity, fixture source or model stub is substituted.\n`,
    );
    return false;
  }
  return true;
}

function up(mode) {
  if (mode === 'live' && !requireLive()) return 1;
  const env = currentEnv(mode);
  if (
    docker(['image', 'inspect', 'aw-m1:local'], env, { capture: true, quiet: true }).status !== 0
  ) {
    const built = docker([...compose, 'build', 'builder'], env);
    if (built.status !== 0) return built.status ?? 1;
  }
  const result = docker(
    [
      ...composeFor(mode),
      'up',
      '-d',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '600',
      '--force-recreate',
      ...appServices,
    ],
    env,
  );
  if (result.status !== 0) {
    docker(
      [...composeFor(mode), 'logs', '--tail', '40', 'builder', 'api-alpha', 'api-beta', 'web'],
      env,
    );
    return result.status ?? 1;
  }
  process.stdout.write(`M1 is up in ${mode} mode: http://localhost:${PROJECTS[mode].port}\n`);
  return 0;
}

/** Mock stacks never mount the secrets directory, even when one exists on the host. */
function currentEnv(mode) {
  const env = { ...baseEnv, ...MODES[mode], AW_M1_PORT: PROJECTS[mode].port };
  if (mode !== 'live') {
    const empty = join(process.env.TMPDIR ?? '/tmp', 'aw-m1-no-secrets');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'e2e-session.secret'), '');
    env.AW_M1_SECRETS_DIR = empty;
  }
  return env;
}

function toolbox(command, mode = 'local-test') {
  return (
    docker(
      [
        ...composeFor(mode),
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
      ],
      currentEnv(mode),
    ).status ?? 1
  );
}

const GATES = {
  install: 'pnpm install --frozen-lockfile',
  build: 'pnpm build',
  typecheck: 'pnpm typecheck',
  eslint: 'pnpm lint:eslint',
  unit: 'pnpm test',
};

function test() {
  const results = {};
  for (const [name, command] of Object.entries(GATES)) {
    results[name] = toolbox(command) === 0 ? 'PASS' : 'FAIL';
  }
  report('test', { results });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  return Object.values(results).every((value) => value === 'PASS') ? 0 : 1;
}

function playwright(project, suite, extra = [], vars = {}) {
  const mode = project === 'live' ? 'live' : project === 'ux' ? 'ux' : 'local-test';
  // Each Compose project has its own node_modules volumes; a no-op when already installed.
  if (toolbox('pnpm install --frozen-lockfile >/dev/null', mode) !== 0) return 1;
  return (
    docker(
      [
        ...composeFor(mode),
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '-e',
        `M1_SUITE=${suite}`,
        ...Object.entries(vars).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        'e2e',
        'node_modules/.bin/playwright',
        'test',
        '-c',
        'e2e/m1',
        `--project=${project}`,
        ...extra,
      ],
      currentEnv(mode),
    ).status ?? 1
  );
}

function e2e(project) {
  const started = up(project === 'live' ? 'live' : 'local-test');
  if (started !== 0) return started;
  return playwright(project, project);
}

/** One UI review round on the scripted-model stack: key-journey video plus screens at 375/768/1440. */
function ux(round) {
  const started = up('ux');
  if (started !== 0) return started;
  return playwright('ux', 'ux', [], { M1_UX_ROUND: round });
}

/** Kill the alpha segment API mid-assignment, then restart the whole stack, then verify recovery. */
function restart() {
  const started = up('local-test');
  if (started !== 0) return started;
  if (playwright('restart-before', 'restart-before') !== 0) return 1;
  const env = currentEnv('local-test');
  docker([...composeFor('local-test'), 'kill', 'api-alpha'], env);
  docker([...composeFor('local-test'), 'stop'], env);
  const again = docker(
    [
      ...composeFor('local-test'),
      'up',
      '-d',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '600',
      ...appServices,
    ],
    env,
  );
  if (again.status !== 0) return again.status ?? 1;
  return playwright('restart-after', 'restart-after');
}

/** `--index-only` indexes the existing artifacts without rerunning the suite (no Vertex calls). */
function evidence(args) {
  const local = args.includes('--index-only') ? 0 : e2e('local');
  const files = (dir) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => /\.(png|webm)$/.test(f))
          .sort()
      : [];
  const index = [
    '# M1 evidence index (local, gitignored)',
    '',
    `Generated ${new Date().toISOString()}. Mock stack: mock identities, fixture sources, mocked Google and GitHub, real Vertex. ${args.includes('--index-only') ? 'Indexed existing artifacts.' : `Local suite exit ${local}.`}`,
    '',
    '## Screenshots',
    ...files(join(artifacts, 'screenshots')).map((f) => `- screenshots/${f}`),
    '',
    '## Videos',
    ...files(join(artifacts, 'videos', 'local')).map((f) => `- videos/local/${f}`),
    '',
    '## Machine-readable results',
    ...readdirSync(artifacts)
      .filter((f) => f.endsWith('.json'))
      .map((f) => `- ${f}`),
    '',
  ];
  writeFileSync(join(artifacts, 'evidence-index.md'), index.join('\n'));
  return local;
}

function verify() {
  const gates = {};
  gates.test = test() === 0 ? 'PASS' : 'FAIL';
  gates.e2eLocal = e2e('local') === 0 ? 'PASS' : 'FAIL';
  // After e2e, so the stack is built; the smoke reads the served model version from Vertex.
  gates.doctor = doctor(['--vertex']) === 0 ? 'PASS' : 'FAIL';
  gates.restart = restart() === 0 ? 'PASS' : 'FAIL';
  const outOfScope = {
    e2eLive: "MOVED to a later milestone by Yu's decision (M1 is mock-only)",
    visualBaselineReview: "MOVED to the UI/UX milestone by Yu's decision (M17)",
    usabilityReview: "MOVED to the UI/UX milestone by Yu's decision (M19)",
  };
  report('verify', {
    gates,
    outOfScope,
    note: 'Moved gates are reported separately and never counted as passed by this script.',
  });
  process.stdout.write(`${JSON.stringify({ gates, outOfScope }, null, 2)}\n`);
  return Object.values(gates).every((value) => value === 'PASS') ? 0 : 1;
}

const [command, ...args] = process.argv.slice(2);
let code;
switch (command) {
  case 'doctor':
    code = doctor(args);
    break;
  case 'up':
    code = up(args.includes('--live-stack') ? 'live' : 'local-test');
    break;
  case 'down':
    code = Math.max(
      ...Object.keys(PROJECTS).map(
        (mode) => docker([...composeFor(mode), 'down'], currentEnv(mode)).status ?? 1,
      ),
    );
    break;
  case 'reset':
    if (!args.includes('--yes-delete-m1-volumes')) {
      process.stderr.write(
        'reset deletes every aw-m1 volume (tasks, sessions, connections, keys). Re-run with --yes-delete-m1-volumes.\n',
      );
      code = 2;
    } else {
      const mode = args.includes('--live-stack') ? 'live' : 'local-test';
      code = docker([...composeFor(mode), 'down', '--volumes'], currentEnv(mode)).status ?? 1;
    }
    break;
  case 'test':
    code = test();
    break;
  case 'e2e':
    code = e2e(args[0] === 'live' ? 'live' : 'local');
    break;
  case 'ux':
    code = ux(args[0] ?? '1');
    break;
  case 'restart':
    code = restart();
    break;
  case 'evidence':
    code = evidence(args);
    break;
  case 'verify':
    code = verify();
    break;
  default:
    process.stderr.write(
      'usage: node scripts/m1/run.mjs doctor|up|down|reset|test|e2e|ux|restart|evidence|verify\n',
    );
    code = 2;
}
process.exit(code);
