#!/usr/bin/env node
// UI milestone lifecycle and verification on the M1 mock stack (Compose project aw-m1-local,
// http://127.0.0.1:8281). Mock identity, fixture sources, real Vertex under campaign ui-2026-10.
// Everything runs in Compose; this host script only orchestrates. The project's volumes hold the
// persistent model ledger, so there is no reset command here.
//   node scripts/ui/run.mjs doctor [--vertex]     prerequisites; --vertex spends 1 call per segment
//   node scripts/ui/run.mjs up                    build, migrate, start both segments, wait for health
//   node scripts/ui/run.mjs down                  stop, keep data
//   node scripts/ui/run.mjs restart               restart the stack and verify recovery
//   node scripts/ui/run.mjs test                  install, build, typecheck, ESLint, vitest (toolbox)
//   node scripts/ui/run.mjs e2e focused|journeys  browser suites; refuses anything but the real model
//   node scripts/ui/run.mjs visual                captures, compared against approved baselines only
//   node scripts/ui/run.mjs evidence [--run]      evidence index; --run executes the journeys first
//   node scripts/ui/run.mjs verify [--with-smoke] every machine gate plus the human gates' status
//   node scripts/ui/run.mjs seed-review --member=<alice|bob> [--with-approval]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  REMEDIATION,
  SEGMENTS,
  UI,
  adcPath,
  appServices,
  artifacts,
  compose,
  composeConfig,
  containerId,
  docker,
  gitSha,
  ledger,
  playwright,
  preflight,
  printChecks,
  report,
  toolbox,
} from './stack.mjs';

const SEGMENT_APIS = SEGMENTS.map((segment) => `api-${segment}`);
const ADC_TARGET = '/home/app/.config/gcloud';

/** Expected per-service settings in the expanded Compose model. */
const WANTED_SEGMENT_ENV = {
  LLM_MODE: UI.llmMode,
  VERTEX_MODEL_ID: UI.modelId,
  AW_MODEL_CAMPAIGN: UI.campaign,
  AW_MAX_MODEL_CALLS: UI.callsPerSegment,
  AW_WORKER_CONCURRENCY: UI.concurrency,
  AW_IDENTITY: 'local-test',
  AW_SOURCE_MODE: 'fixture',
};

function check(name, ok, detail, remediation) {
  return { name, status: ok ? 'PASS' : 'FAIL', detail, ...(ok ? {} : { remediation }) };
}

function skipped(name, detail) {
  return { name, status: 'SKIP', detail };
}

function configChecks(config) {
  const checks = [];
  if (config === undefined) {
    checks.push(check('compose config', false, 'compose.m1.yaml does not expand', 'see stderr'));
    return checks;
  }
  checks.push(check('compose config', true, `project ${config.name}`));
  const mounted = Object.entries(config.services)
    .filter(([, service]) => (service.volumes ?? []).some((v) => v.target === ADC_TARGET))
    .map(([name]) => name)
    .sort();
  checks.push(
    check(
      'ADC mounted only on segment APIs',
      mounted.join(',') === SEGMENT_APIS.join(','),
      mounted.join(', ') || 'none',
      'compose.m1.yaml must bind ADC on api-alpha and api-beta only',
    ),
  );
  for (const name of SEGMENT_APIS) {
    const service = config.services[name];
    const mount = (service?.volumes ?? []).find((v) => v.target === ADC_TARGET);
    checks.push(
      check(
        `${name} ADC bind read-only from host config dir`,
        mount?.type === 'bind' && mount.read_only === true && mount.source === dirname(adcPath),
        mount
          ? `${mount.source} -> ${mount.target}${mount.read_only ? ' (ro)' : ' (rw)'}`
          : 'absent',
        'set GCLOUD_CONFIG_DIR to the directory holding application_default_credentials.json',
      ),
    );
    const env = service?.environment ?? {};
    const wrong = Object.entries(WANTED_SEGMENT_ENV).filter(([key, value]) => env[key] !== value);
    checks.push(
      check(
        `${name} UI env`,
        wrong.length === 0,
        wrong.length === 0
          ? `campaign ${env.AW_MODEL_CAMPAIGN}, cap ${env.AW_MAX_MODEL_CALLS}, concurrency ${env.AW_WORKER_CONCURRENCY}`
          : wrong.map(([key, value]) => `${key}=${env[key] ?? 'unset'} (want ${value})`).join('; '),
        'the UI commands set these; do not override AW_M1_* in the shell',
      ),
    );
  }
  const port = (config.services.web?.ports ?? [])[0];
  checks.push(
    check(
      'web port bound to loopback',
      port?.host_ip === '127.0.0.1' && String(port.published) === UI.port,
      port ? `${port.host_ip}:${port.published}` : 'none',
      `expected 127.0.0.1:${UI.port}`,
    ),
  );
  return checks;
}

function ledgerChecks() {
  const checks = [];
  const usage = {};
  for (const segment of SEGMENTS) {
    if (containerId(`pg-${segment}`) === undefined) {
      checks.push(skipped(`${segment} campaign allowance`, 'database not running (pnpm ui:up)'));
      continue;
    }
    const state = ledger(segment);
    usage[segment] = state;
    if (state.state === 'missingMigration') {
      checks.push(
        check(
          `${segment} campaign allowance`,
          false,
          'wb_model_calls has no campaign column',
          'migration 0020 is not applied to this database yet; run pnpm ui:up from this branch',
        ),
      );
    } else if (state.state === 'unavailable') {
      checks.push(skipped(`${segment} campaign allowance`, state.detail));
    } else {
      const lastFix = REMEDIATION[state.lastOutcome];
      checks.push(
        check(
          `${segment} campaign allowance`,
          state.remaining > 0,
          `${state.used} of ${state.cap} used under ${UI.campaign}, ${state.remaining} remaining; last outcome ${state.lastOutcome}${lastFix ? `\n      fix: ${lastFix}` : ''}`,
          REMEDIATION.budget_exhausted,
        ),
      );
    }
  }
  return { checks, usage };
}

/** One bounded Vertex call per segment through the product's own gate and ledger. */
function smokeChecks() {
  return SEGMENTS.map((segment) => {
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
      { capture: true, quiet: true },
    );
    const line = result.stdout.trim().split('\n').at(-1) ?? '';
    return check(`vertex smoke (${segment})`, result.status === 0, line, 'see the error field');
  });
}

function doctor(args) {
  const checks = [
    check(
      'docker daemon',
      docker(['version', '--format', '{{.Server.Version}}'], { capture: true, quiet: true })
        .status === 0,
      undefined,
      'start Docker and export DOCKER_HOST if the socket is not the default',
    ),
  ];
  const config = composeConfig();
  checks.push(...configChecks(config));
  checks.push(
    check(
      'ADC file present on host',
      existsSync(adcPath),
      existsSync(adcPath) ? 'existence checked only, never read' : adcPath,
      REMEDIATION.adc_unavailable,
    ),
  );
  const env = config?.services['api-alpha']?.environment ?? {};
  const model = {
    modelId: env.VERTEX_MODEL_ID ?? null,
    location: env.GOOGLE_CLOUD_LOCATION ?? null,
    project: env.GOOGLE_CLOUD_PROJECT ?? null,
    campaign: UI.campaign,
    callsPerSegment: Number(UI.callsPerSegment),
    concurrency: Number(UI.concurrency),
  };
  checks.push(
    check(
      'configured model',
      model.modelId === UI.modelId,
      `${model.modelId} in ${model.location} on ${model.project}`,
      REMEDIATION.model_not_found,
    ),
  );
  const running = SEGMENT_APIS.every((service) => containerId(service) !== undefined);
  const live = running ? preflight() : undefined;
  checks.push(
    ...(live
      ? live.checks
      : [skipped('running stack matches UI env', 'stack not running (pnpm ui:up)')]),
  );
  const { checks: usageChecks, usage } = ledgerChecks();
  checks.push(...usageChecks);
  if (args.includes('--vertex')) checks.push(...smokeChecks());
  printChecks(checks);
  process.stdout.write('\nRemediation by model error code:\n');
  for (const [code, text] of Object.entries(REMEDIATION))
    process.stdout.write(`  ${code}: ${text}\n`);
  const file = report('doctor', {
    checks,
    model,
    running: live?.facts ?? null,
    usage,
    remediation: REMEDIATION,
  });
  process.stdout.write(`wrote ${file}\n`);
  return checks.every((item) => item.status !== 'FAIL') ? 0 : 1;
}

function up() {
  if (docker(['image', 'inspect', 'aw-m1:local'], { capture: true, quiet: true }).status !== 0) {
    const built = docker([...compose, 'build', 'builder']);
    if (built.status !== 0) return built.status ?? 1;
  }
  const result = docker([
    ...compose,
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '600',
    '--force-recreate',
    ...appServices,
  ]);
  if (result.status !== 0) {
    docker([...compose, 'logs', '--tail', '40', 'builder', 'api-alpha', 'api-beta', 'web']);
    return result.status ?? 1;
  }
  process.stdout.write(`UI stack is up: http://127.0.0.1:${UI.port} (campaign ${UI.campaign})\n`);
  return 0;
}

function down() {
  return docker([...compose, 'down']).status ?? 1;
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
  report('test', { results, build: gitSha() });
  process.stdout.write(`${JSON.stringify(results)}\n`);
  return Object.values(results).every((value) => value === 'PASS') ? 0 : 1;
}

/** Refuses to run a browser suite unless the running stack is on the real model. */
function requireRealModel() {
  const live = preflight();
  printChecks(live.checks);
  if (!live.ok) {
    process.stderr.write(
      'Refusing to run browser tests: the stack is not on the requested real model. No scripted or offline fallback exists.\n',
    );
  }
  return live;
}

function e2e(suite) {
  if (!['focused', 'journeys'].includes(suite)) {
    process.stderr.write('usage: e2e focused|journeys\n');
    return 2;
  }
  if (!requireRealModel().ok) return 1;
  return playwright(suite);
}

/** Every test in a Playwright JSON report, flattened. */
function* tests(suites) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) {
        yield {
          title: spec.title,
          file: spec.file,
          status: item.status,
          annotations: [
            ...(item.annotations ?? []),
            ...(item.results ?? []).flatMap((r) => r.annotations ?? []),
          ],
        };
      }
    }
    yield* tests(suite.suites);
  }
}

function results(suite) {
  const file = join(artifacts, `results-${suite}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return { file, stats: parsed.stats, tests: [...tests(parsed.suites)] };
}

function pngs(dir) {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith('.png'))
        .sort()
    : [];
}

/**
 * Captures compare only against artifacts/ui/baselines/approved/. With no approved file for a
 * capture the spec records a `pending-baseline` annotation and the gate stays PENDING; this
 * command never writes an approved baseline.
 */
function visual() {
  if (!requireRealModel().ok) return { status: 'BLOCKED', code: 1 };
  const code = playwright('visual');
  const run = results('visual');
  const approved = pngs(join(artifacts, 'baselines/approved'));
  const pending = run
    ? run.tests.flatMap((t) =>
        t.annotations.filter((a) => a.type === 'pending-baseline').map((a) => a.description),
      )
    : [];
  const failed = run
    ? run.tests.filter((t) => t.status !== 'expected' && t.status !== 'skipped')
    : [];
  const status =
    code !== 0 || failed.length > 0
      ? 'FAIL'
      : approved.length === 0 || pending.length > 0
        ? 'PENDING'
        : 'PASS';
  const summary = {
    status,
    approvedBaselines: approved.length,
    pendingCaptures: pending,
    failedTests: failed.map((t) => t.title),
    captures: pngs(join(artifacts, 'screenshots')),
    build: gitSha(),
  };
  report('visual', summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (status === 'PENDING')
    process.stdout.write(
      `Visual gate PENDING: ${approved.length} approved baselines, ${pending.length} captures await review in ${artifacts}/screenshots/. Approval is a human step (docs/ui/README.md).\n`,
    );
  return { status, code: status === 'FAIL' ? 1 : 0 };
}

/** Patterns that must never appear in an evidence file. Only their names are reported. */
const SECRET_PATTERNS = {
  'session cookie': /aw_m1_[a-z]+=[A-Za-z0-9._-]{8,}/,
  'set-cookie header': /set-cookie/i,
  'bearer token': /Bearer [A-Za-z0-9._-]{16,}/,
  'e2e secret header': /x-e2e-secret/i,
  'ADC content': /"(refresh_token|client_secret|private_key)"/,
};

function files(dir, pattern) {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map(String)
        .filter((f) => pattern.test(f))
        .sort()
        .map((f) => {
          const stat = statSync(join(dir, f));
          return { path: join(dir, f), bytes: stat.size, modified: stat.mtime.toISOString() };
        })
    : [];
}

function evidence(args) {
  const ran = args.includes('--run') ? e2e('journeys') : null;
  const running = SEGMENT_APIS.every((service) => containerId(service) !== undefined);
  const live = running ? preflight() : undefined;
  const resultFiles = files(artifacts, /^results-[a-z-]+\.json$/);
  const leaks = resultFiles.flatMap(({ path }) => {
    const text = readFileSync(path, 'utf8');
    return Object.entries(SECRET_PATTERNS)
      .filter(([, pattern]) => pattern.test(text))
      .map(([name]) => ({ path, pattern: name }));
  });
  const manifest = {
    build: gitSha(),
    stack: running
      ? { ...live.facts.alpha, realModel: live.ok }
      : { note: 'stack not running when indexed; mode unknown' },
    journeysRun: ran === null ? 'indexed existing artifacts' : ran === 0 ? 'PASS' : 'FAIL',
    videos: files(join(artifacts, 'test-results'), /\.webm$/),
    screenshots: files(join(artifacts, 'screenshots'), /\.png$/),
    results: resultFiles.map((entry) => ({
      ...entry,
      summary: results(entry.path.match(/results-([a-z-]+)\.json$/)[1])?.stats ?? null,
    })),
    sanitized: leaks.length === 0,
    leaks,
  };
  report('evidence', manifest);
  const line = (entry) => `- ${entry.path} (${entry.bytes} bytes, ${entry.modified})`;
  writeFileSync(
    join(artifacts, 'evidence-index.md'),
    [
      '# UI milestone evidence index (local, gitignored)',
      '',
      `Generated ${new Date().toISOString()} at build ${manifest.build}.`,
      `Stack: ${JSON.stringify(manifest.stack)}.`,
      `Identity and sources are simulated (local-test members, fixture files); the model is ${running ? `${manifest.stack.llmMode} ${manifest.stack.modelId}` : 'unknown'}.`,
      `Journeys: ${manifest.journeysRun}. Sanitized: ${manifest.sanitized ? 'yes' : `NO (${leaks.map((l) => `${l.pattern} in ${l.path}`).join('; ')})`}.`,
      '',
      '## Videos',
      ...manifest.videos.map(line),
      '',
      '## Screenshots',
      ...manifest.screenshots.map(line),
      '',
      '## Machine-readable results',
      ...manifest.results.map((entry) => `${line(entry)} ${JSON.stringify(entry.summary)}`),
      '',
    ].join('\n'),
  );
  process.stdout.write(`wrote ${join(artifacts, 'evidence-index.md')} and evidence.json\n`);
  if (leaks.length > 0) {
    process.stderr.write(
      `Evidence is not sanitized: ${leaks.map((l) => `${l.pattern} in ${l.path}`).join('; ')}\n`,
    );
    return 1;
  }
  return ran ?? 0;
}

/** Restart recovery: kill a segment API, restart everything, verify health and the after-spec. */
function restart() {
  const started = up();
  if (started !== 0) return started;
  const before = existsSync('e2e/ui/restart/before.spec.ts');
  const after = existsSync('e2e/ui/restart/after.spec.ts');
  if (before && playwright('restart-before') !== 0) return 1;
  docker([...compose, 'kill', 'api-alpha']);
  docker([...compose, 'stop']);
  const again = docker([
    ...compose,
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '600',
    ...appServices,
  ]);
  if (again.status !== 0) return again.status ?? 1;
  const healthy = preflight().ok;
  const recovered = after ? playwright('restart-after') === 0 : null;
  report('restart', {
    healthyAfterRestart: healthy,
    recoverySpec: after
      ? recovered
        ? 'PASS'
        : 'FAIL'
      : 'PENDING (e2e/ui/restart/after.spec.ts not written yet)',
    build: gitSha(),
  });
  return healthy && recovered !== false ? 0 : 1;
}

/** A human gate's status is read from its document's `Status: **WORD**` line, never inferred. */
function humanGate(doc) {
  if (!existsSync(doc)) return { status: 'PENDING', source: `${doc} does not exist yet` };
  const match = /Status:\s*\*\*(PASS|PENDING|FAIL|BLOCKED)\*\*/.exec(readFileSync(doc, 'utf8'));
  return match
    ? { status: match[1], source: doc }
    : { status: 'PENDING', source: `${doc} has no "Status: **WORD**" line` };
}

const HUMAN_GATES = {
  U18_visualBaselineApproval: 'docs/ui/VISUAL_REVIEW.md',
  U20_usability: 'docs/ui/UX_REVIEW.md',
};

function verify(args) {
  const gates = {};
  const mandatory = [
    'U2_realModelPrerequisites',
    'U21_test',
    'U14_e2eFocused',
    'U14_e2eJourneys',
    'U1_restart',
  ];
  gates.U21_test = test() === 0 ? 'PASS' : 'FAIL';
  const started = up();
  const live = started === 0 ? preflight() : { ok: false, checks: [] };
  printChecks(live.checks);
  gates.U2_realModelPrerequisites = live.ok ? 'PASS' : 'FAIL';
  if (live.ok) {
    gates.U14_e2eFocused = playwright('focused') === 0 ? 'PASS' : 'FAIL';
    gates.U14_e2eJourneys = playwright('journeys') === 0 ? 'PASS' : 'FAIL';
    gates.U1_restart = restart() === 0 ? 'PASS' : 'FAIL';
    gates.U18_visualComparison = visual().status;
    gates.U2_vertexSmoke = args.includes('--with-smoke')
      ? doctor(['--vertex']) === 0
        ? 'PASS'
        : 'FAIL'
      : 'SKIPPED (pass --with-smoke; spends 1 call per segment)';
  } else {
    for (const gate of [
      'U14_e2eFocused',
      'U14_e2eJourneys',
      'U1_restart',
      'U18_visualComparison',
      'U2_vertexSmoke',
    ])
      gates[gate] = 'BLOCKED (real-model prerequisites failed)';
  }
  const human = Object.fromEntries(
    Object.entries(HUMAN_GATES).map(([gate, doc]) => [gate, humanGate(doc)]),
  );
  const failedMandatory = mandatory.filter((gate) => gates[gate] !== 'PASS');
  const summary = {
    build: gitSha(),
    gates,
    human,
    failedMandatory,
    note: 'Human gates are copied from their documents and never set by this script. An all-machine pass does not complete the milestone.',
  };
  report('verify', summary);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return failedMandatory.length === 0 && gates.U2_vertexSmoke !== 'FAIL' ? 0 : 1;
}

/** Creates a reviewer's starter teammates through the web app, as that member. No model calls. */
function seedReview(args) {
  const member = args.find((arg) => arg.startsWith('--member='))?.slice('--member='.length);
  if (!['alice', 'bob'].includes(member ?? '')) {
    process.stderr.write('usage: seed-review --member=<alice|bob> [--with-approval]\n');
    return 2;
  }
  if (containerId('web') === undefined) {
    process.stderr.write('The stack is not running. Start it with pnpm ui:up.\n');
    return 1;
  }
  if (args.includes('--with-approval')) {
    process.stderr.write(
      'TODO: --with-approval is not implemented yet. It will run a real-model task to a result and request a publication approval for it (about 6 calls). Seed the teammates without it for now.\n',
    );
    return 3;
  }
  return (
    docker([
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      'e2e',
      'node',
      'scripts/ui/seed-review.mjs',
      `--member=${member}`,
    ]).status ?? 1
  );
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  doctor: () => doctor(args),
  up,
  down,
  restart,
  test,
  e2e: () => e2e(args[0] ?? ''),
  visual: () => visual().code,
  evidence: () => evidence(args),
  verify: () => verify(args),
  'seed-review': () => seedReview(args),
};
const run = commands[command];
if (run === undefined) {
  process.stderr.write(
    'usage: node scripts/ui/run.mjs doctor|up|down|restart|test|e2e|visual|evidence|verify|seed-review\n',
  );
  process.exit(2);
}
process.exit(run());
