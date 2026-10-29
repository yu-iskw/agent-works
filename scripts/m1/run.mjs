#!/usr/bin/env node
// M1 lifecycle and verification. Everything runs in Compose; this host script only orchestrates.
//   node scripts/m1/run.mjs doctor [--live]      prerequisites; --live also spends 1 Vertex call per segment
//   node scripts/m1/run.mjs up [--local-test]    build, migrate, start both segments, wait for health
//   node scripts/m1/run.mjs down                 stop, keep data
//   node scripts/m1/run.mjs reset --yes-delete-m1-volumes [--local-test]   delete only that M1 project's volumes
//   node scripts/m1/run.mjs test                 build, typecheck, ESLint, unit and integration tests
//   node scripts/m1/run.mjs e2e [local|live]     browser suites (local: labelled local-test identity)
//   node scripts/m1/run.mjs ux <round>           UI review round (scripted model, no Vertex calls)
//   node scripts/m1/run.mjs restart              kill a segment API mid-assignment, restart everything, verify recovery
//   node scripts/m1/run.mjs evidence             live journeys with video, plus screenshot sweep
//   node scripts/m1/run.mjs verify               every machine gate; non-zero on any failure or missing live prerequisite
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

/** Keys the live stack needs; doctor reports each as set or missing, never a value. */
const REQUIRED = [
  'AW_M1_GOOGLE_CLIENT_ID',
  'AW_M1_GOOGLE_CLIENT_SECRET',
  'AW_M1_GITHUB_CLIENT_ID',
  'AW_M1_GITHUB_CLIENT_SECRET',
  'AW_M1_ALPHA_MEMBERS',
  'AW_M1_BETA_MEMBERS',
  'AW_M1_E2E_SESSION_SECRET',
  'AW_M1_ALPHA_DRIVE_RESEARCH_FOLDER',
  'AW_M1_ALPHA_DRIVE_CONTEXT_FOLDER',
  'AW_M1_BETA_DRIVE_RESEARCH_FOLDER',
  'AW_M1_BETA_DRIVE_CONTEXT_FOLDER',
  'AW_M1_BIGQUERY_PROJECT',
  'AW_M1_ALPHA_BIGQUERY_DATASET',
  'AW_M1_BETA_BIGQUERY_DATASET',
  'AW_M1_GITHUB_REPOSITORY',
  'AW_M1_ALPHA_GITHUB_ISSUE',
  'AW_M1_BETA_GITHUB_ISSUE',
];

const MODES = {
  live: {
    AW_M1_IDENTITY: 'google',
    AW_M1_SOURCE_MODE: 'live',
    AW_M1_FIXTURE_FAULTS: '0',
    AW_M1_E2E_MODE: '1',
    AW_M1_PORT: '8280',
    AW_M1_MAX_MODEL_CALLS_PER_SEGMENT: '200',
  },
  // UI review rounds: scripted model, so a round costs no Vertex calls. Labelled on every page.
  ux: {
    AW_M1_IDENTITY: 'local-test',
    AW_M1_SOURCE_MODE: 'fixture',
    AW_M1_FIXTURE_FAULTS: '1',
    AW_M1_E2E_MODE: '0',
    AW_M1_PORT: '8282',
    AW_M1_LLM_MODE: 'scripted',
  },
  'local-test': {
    AW_M1_IDENTITY: 'local-test',
    AW_M1_SOURCE_MODE: 'fixture',
    AW_M1_FIXTURE_FAULTS: '1',
    AW_M1_E2E_MODE: '0',
    AW_M1_PORT: '8281',
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
    docker([...compose, 'config', '--quiet'], baseEnv, { capture: true, quiet: true }).status === 0,
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
  if (args.includes('--live')) {
    for (const segment of ['alpha', 'beta']) {
      const result = docker(
        [
          ...compose,
          'run',
          '--rm',
          '--no-deps',
          '-T',
          `api-${segment}`,
          'node',
          'apps/api/dist/teamwork/smoke.js',
        ],
        { ...baseEnv, ...MODES.live },
        { capture: true, quiet: true },
      );
      const line = result.stdout.trim().split('\n').at(-1) ?? '';
      add(`vertex smoke (${segment})`, result.status === 0, line);
    }
  }
  report('doctor', { checks });
  return checks.every((check) => check.ok) ? 0 : 1;
}

function requireLive() {
  if (secretsFile() === undefined) {
    process.stderr.write(
      `Live mode needs ${join(secretsDir, 'm1.env')} (docs/m1/SETUP_OAUTH.md). Nothing was started. For the labelled local-test stack use: up --local-test\n`,
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
  const env = { ...baseEnv, ...MODES[mode] };
  if (mode !== 'live' && !existsSync(secretsDir)) {
    const empty = join(process.env.TMPDIR ?? '/tmp', 'aw-m1-no-secrets');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'e2e-session.secret'), '');
    env.AW_M1_SECRETS_DIR = empty;
  }
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

function currentEnv(mode) {
  const env = { ...baseEnv, ...MODES[mode] };
  if (mode !== 'live' && !existsSync(secretsDir))
    env.AW_M1_SECRETS_DIR = join(process.env.TMPDIR ?? '/tmp', 'aw-m1-no-secrets');
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
  if (project === 'live') {
    if (!requireLive()) return 2;
    const started = up('live');
    if (started !== 0) return started;
    return playwright('live', 'live');
  }
  const started = up('local-test');
  if (started !== 0) return started;
  return playwright('local', 'local');
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

function evidence() {
  mkdirSync(join(artifacts, 'screenshots'), { recursive: true });
  const live = e2e('live');
  const local = e2e('local');
  const files = (dir) =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true })
          .map(String)
          .filter((f) => /\.(png|webm|json)$/.test(f))
          .sort()
      : [];
  const index = [
    '# M1 evidence index (local, gitignored)',
    '',
    `Generated ${new Date().toISOString()}. Live suite exit ${live}, local suite exit ${local}.`,
    '',
    '## Screenshots',
    ...files(join(artifacts, 'screenshots')).map((f) => `- screenshots/${f}`),
    '',
    '## Videos',
    ...files(join(artifacts, 'test-results', 'live'))
      .filter((f) => f.endsWith('.webm'))
      .map((f) => `- test-results/live/${f}`),
    '',
    '## Machine-readable results',
    ...readdirSync(artifacts)
      .filter((f) => f.endsWith('.json'))
      .map((f) => `- ${f}`),
    '',
  ];
  writeFileSync(join(artifacts, 'evidence-index.md'), index.join('\n'));
  return live === 0 && local === 0 ? 0 : 1;
}

function verify() {
  const gates = {};
  gates.doctor = doctor(['--live']) === 0 ? 'PASS' : 'FAIL';
  gates.test = test() === 0 ? 'PASS' : 'FAIL';
  gates.e2eLocal = e2e('local') === 0 ? 'PASS' : 'FAIL';
  gates.restart = restart() === 0 ? 'PASS' : 'FAIL';
  const live = e2e('live');
  gates.e2eLive = live === 0 ? 'PASS' : live === 2 ? 'BLOCKED' : 'FAIL';
  const human = {
    visualBaselineReview: 'PENDING',
    usabilityReview: 'PENDING',
    videoPlaybackReview: 'PENDING',
  };
  report('verify', {
    gates,
    human,
    note: 'Human gates are reported separately and never counted as passed by this script.',
  });
  process.stdout.write(`${JSON.stringify({ gates, human }, null, 2)}\n`);
  return Object.values(gates).every((value) => value === 'PASS') ? 0 : 1;
}

const [command, ...args] = process.argv.slice(2);
let code;
switch (command) {
  case 'doctor':
    code = doctor(args);
    break;
  case 'up':
    code = up(args.includes('--local-test') ? 'local-test' : 'live');
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
      const mode = args.includes('--local-test') ? 'local-test' : 'live';
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
    code = evidence();
    break;
  case 'verify':
    code = verify();
    break;
  default:
    process.stderr.write(
      'usage: node scripts/m1/run.mjs doctor|up|down|reset|test|e2e|evidence|verify\n',
    );
    code = 2;
}
process.exit(code);
