#!/usr/bin/env node
// Runs the P0 acceptance suites against compose.p0.yaml, switching the stack mode per suite:
//   node scripts/p0-e2e.mjs fixture|misconfig|restart|real|all
// fixture/misconfig/restart make no Vertex calls. real makes 2 (smoke + flagship).
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const compose = ['compose', '-f', 'compose.p0.yaml'];
const artifacts = 'artifacts/p0';
const baseEnv = {
  ...process.env,
  HOST_UID: String(process.getuid?.() ?? 1000),
  HOST_GID: String(process.getgid?.() ?? 1000),
};

const appServices = ['builder', 'fake-directory', 'api', 'web', 'fake-iap'];

const modes = {
  stub: { AW_P0_LLM_MODE: 'stub', AW_P0_FIXTURE_FAULTS: '1' },
  misconfig: { AW_P0_LLM_MODE: 'vertex', AW_P0_VERTEX_MODEL_ID: '', AW_P0_FIXTURE_FAULTS: '0' },
  vertex: { AW_P0_LLM_MODE: 'vertex', AW_P0_FIXTURE_FAULTS: '0' },
};

function docker(args, env, options = {}) {
  process.stdout.write(`$ docker ${args.join(' ')}\n`);
  const result = spawnSync('docker', args, {
    stdio: options.capture ? 'pipe' : 'inherit',
    env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result;
}

function up(mode) {
  const env = { ...baseEnv, ...modes[mode] };
  // Recreate app services so they always run what the builder just produced.
  const result = docker(
    [...compose, 'up', '-d', '--wait', '--wait-timeout', '600', '--force-recreate', ...appServices],
    env,
  );
  if (result.status !== 0) throw new Error(`stack failed to start in ${mode} mode`);
  return env;
}

function playwright(env, project, suite) {
  const result = docker(
    [
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-e',
      `P0_SUITE=${suite}`,
      'e2e',
      'node_modules/.bin/playwright',
      'test',
      '-c',
      'e2e/p0/playwright.config.ts',
      '--project',
      project,
    ],
    env,
  );
  return result.status === 0;
}

function collectVideos() {
  const root = join(artifacts, 'test-results');
  const out = join(artifacts, 'videos');
  mkdirSync(out, { recursive: true });
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  for (const file of walk(root).filter(
    (path) => path.endsWith('.webm') && path.includes('one-write'),
  )) {
    copyFileSync(file, join(out, 'flagship-real-gemini.webm'));
    process.stdout.write(`video: ${join(out, 'flagship-real-gemini.webm')}\n`);
  }
}

const suites = {
  fixture() {
    return playwright(up('stub'), 'fixture', 'fixture');
  },
  misconfig() {
    const ok = playwright(up('misconfig'), 'misconfig', 'misconfig');
    return ok;
  },
  restart() {
    const env = up('stub');
    if (!playwright(env, 'restart-before', 'restart-before')) return false;
    if (
      docker([...compose, 'restart', 'postgres', 'api', 'web', 'fake-iap', 'fake-directory'], env)
        .status !== 0
    )
      return false;
    up('stub');
    return playwright(env, 'restart-after', 'restart-after');
  },
  real() {
    const env = up('vertex');
    const smoke = docker(
      [...compose, 'exec', '-T', 'api', 'node', 'apps/api/dist/workbench/vertex-smoke.js'],
      env,
      {
        capture: true,
      },
    );
    process.stdout.write(smoke.stdout);
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'vertex-smoke.json'), smoke.stdout);
    if (smoke.status !== 0) return false;
    const ok = playwright(env, 'real-llm', 'real-llm');
    collectVideos();
    return ok;
  },
};

const requested = process.argv[2] ?? 'all';
const order = requested === 'all' ? ['fixture', 'misconfig', 'restart', 'real'] : [requested];
if (!order.every((name) => name in suites)) {
  process.stderr.write('usage: node scripts/p0-e2e.mjs fixture|misconfig|restart|real|all\n');
  process.exit(2);
}
const results = {};
for (const name of order) results[name] = suites[name]() ? 'pass' : 'fail';
process.stdout.write(`${JSON.stringify(results)}\n`);
process.exit(Object.values(results).every((value) => value === 'pass') ? 0 : 1);
