import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadRuntime } from '../../tools/evals/runtime.mjs';
import { scoreDataset } from '../../tools/evals/scorer.mjs';
import { loadDataset } from '../../tools/evals/dataset.mjs';
import { runStageGate } from '../ops-03/stage-gate.mjs';
import { formatMarkdown } from './lib/format.mjs';
import {
  gateApprovalRoles,
  gateLiveRequirements,
  gateTasks,
  gateTitles,
  optionalCapabilities,
} from './lib/gates.mjs';
import { planDir, readJson, scanTasks, sha256 } from './lib/scan.mjs';
import { parseSecurity } from './lib/security.mjs';

const offline = { label: 'offline', provenance: 'offline-fixture' };
const live = { label: 'live', provenance: 'live-observed' };
const ops05 = `${planDir}/ops-05`;

const row = (fields) => ({ optional: false, deferReason: null, owner: null, ref: null, ...fields });

function securityRows(security) {
  const overall = row({
    id: 'security:lint-security',
    kind: 'security',
    ...offline,
    status:
      security.status === 'PASS' ? 'PASS' : security.status === 'BLOCKED' ? 'UNTESTED' : 'FAIL',
    ref: `${security.command} exit ${security.exitCode ?? 'unobserved'}`,
  });
  const findings = security.findings.map((finding) =>
    row({
      id: `security:finding:${finding.id}:${finding.file}:${finding.line ?? 'n'}`,
      kind: 'security',
      ...offline,
      status: 'FAIL',
      ref: `${finding.severity} ${finding.file} (${finding.source})`,
    }),
  );
  return [overall, ...findings];
}

function taskRows(tasks, capabilityVerdicts) {
  return tasks.flatMap((task) => {
    const deferred = optionalCapabilities.find((item) => item.task === task.id);
    const local = row({
      id: `${task.id}:local`,
      kind: 'evidence',
      ...offline,
      status: task.local,
      ref: task.evidence ?? 'no evidence.md on the integration head',
    });
    if (deferred) {
      const verdict = capabilityVerdicts.get(task.id);
      return [
        local,
        row({
          id: `${task.id}:capability`,
          kind: 'evidence',
          ...offline,
          status: verdict === 'DEFER' ? 'DEFER' : 'UNTESTED',
          optional: true,
          deferReason: 'optional capability, disabled by default, guard tests present',
          ref: deferred.record,
        }),
      ];
    }
    const first = task.operatorItems[0];
    return [
      local,
      row({
        id: `${task.id}:live`,
        kind: 'evidence',
        ...live,
        status: 'UNTESTED',
        ref: first
          ? `AWAITING_OPERATOR (${task.operatorItems.length} lines): ${first.file}`
          : 'AWAITING_OPERATOR: no live evidence recorded',
      }),
    ];
  });
}

function liveRequirementRows(gate) {
  return gateLiveRequirements[gate].map(([id, , path]) =>
    row({
      id: `${gate}:live:${id}`,
      kind: 'evidence',
      ...live,
      status: 'UNTESTED',
      ref: `AWAITING_OPERATOR: ${path}`,
    }),
  );
}

const priorGateRow = (gate, verdict) =>
  row({
    id: `${gate}:gate-record`,
    kind: 'evidence',
    ...offline,
    status: verdict === 'GO' ? 'PASS' : verdict === 'NO-GO' ? 'FAIL' : 'UNTESTED',
    ref: `${ops05}/gates/${gate}.md verdict ${verdict}`,
  });

function appendix(gate, tasks, reasons) {
  const lines = [
    `## ${gate} ${gateTitles[gate]}: local task statuses`,
    '',
    'Local means offline repository evidence. READY_FOR_REVIEW is not VALIDATED.',
    '',
    '| Task | Declared | Local | Operator lines |',
    '|---|---|---|---|',
    ...tasks.map(
      (task) =>
        `| ${task.id} | ${task.declaredStatus} | ${task.local} | ${task.operatorItems.length} |`,
    ),
    '',
    `## ${gate} operator evidence still needed`,
    '',
    ...gateLiveRequirements[gate].map(([, text, path]) => `- ${text}. Handoff: \`${path}\``),
    `- Per-task live items: see [operator-action-index.md](../operator-action-index.md), section ${gate}.`,
    `- Approvals required from: ${gateApprovalRoles[gate]}. None recorded. Use [go-no-go-form.md](../go-no-go-form.md).`,
    '',
    `Blocking reason count: ${reasons.length}. This record is not an approval and never becomes GO by itself.`,
    '',
  ];
  return lines.join('\n');
}

/** Renders G1..G4 with the OPS-03 gate logic. Returns { G1: { text, verdict, reasons }, ... }. */
export async function renderGates({ root, input, score }) {
  const security = parseSecurity(
    input.securityFile ? readJson(root, input.securityFile) : (input.security ?? {}),
  );
  const files = readdirSync(join(root, 'apps/api/migrations'))
    .filter((n) => /^\d{4}_.+\.sql$/.test(n))
    .sort();
  const migrations = {
    first: files[0].slice(0, 4),
    last: files.at(-1).slice(0, 4),
    count: files.length,
  };
  const policyRevision = [
    'evals/gate-config.json',
    'evals/v1/manifest.json',
    'tools/evals/invariant-map.json',
  ]
    .map((path) => `${path}@${sha256(readFileSync(join(root, path))).slice(0, 12)}`)
    .join(' ');
  const capabilityVerdicts = new Map(
    optionalCapabilities.map((item) => {
      const record = readFileSync(join(root, item.record), 'utf8');
      const ok = /Default and current verdict: \*\*DEFER\*\*/.test(record);
      return [item.task, ok ? 'DEFER' : 'UNTESTED'];
    }),
  );
  const out = {};
  for (const gate of ['G1', 'G2', 'G3', 'G4']) {
    const tasks = scanTasks(root, gateTasks[gate], { evidenceOnly: ['ops-05'] });
    const liveResults = [
      ...securityRows(security),
      ...taskRows(tasks, capabilityVerdicts),
      ...liveRequirementRows(gate),
      ...(gate === 'G4'
        ? ['G1', 'G2', 'G3'].map((prior) => priorGateRow(prior, out[prior].verdict))
        : []),
    ];
    const result = await runStageGate(
      {
        sourceSha: input.sourceSha,
        imageDigests: input.imageDigests ?? [],
        runs: input.runs ?? {},
        approvers: [],
        liveResults,
        gate: `${gate} ${gateTitles[gate]}`,
        environment: 'none (offline repository evidence only; no deployed environment tested)',
        dates: `${input.generatedAt} (offline)`,
        version: 'enterprise-production-v1; no target version approved',
        migrations: `${migrations.first}..${migrations.last} (${migrations.count} files)`,
        policyRevision,
      },
      score,
    );
    const reasons = result.text.split('Blocking reasons:')[1]?.trim().split('\n') ?? [];
    const text = result.text
      .replace(
        '- Reliability and performance sample sizes/results: UNTESTED',
        `- Reliability and performance sample sizes/results: UNTESTED live. Local harness only: ${planDir}/ops-04/evidence.md`,
      )
      .replace(
        '- Residual risks, owner and expiry: UNTESTED',
        `- Residual risks, owner and expiry: ${ops05}/residual-risk-register.md (owners and expiry are placeholders, none approved)`,
      )
      .replace(
        '- Recovery/rollback evidence: UNTESTED',
        `- Recovery/rollback evidence: documented in ${ops05}/rollout-rollback.md; rehearsal UNTESTED (AWAITING_OPERATOR)`,
      );
    out[gate] = {
      verdict: result.verdict,
      reasons,
      text: `${text.trimEnd()}\n\n${appendix(gate, tasks, reasons)}`,
    };
  }
  return out;
}

async function offlineScore() {
  const dataset = loadDataset({ splits: ['dev', 'adversarial', 'holdout'], includeHoldout: true });
  return scoreDataset(dataset.cases, await (await loadRuntime()).runDataset(dataset.cases));
}

/** Usage: node scripts/ops-05/render-gates.mjs <input.json> <outDir>. Exit 0 never means GO. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
    const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const gates = await renderGates({ root, input, score: await offlineScore() });
    for (const [gate, result] of Object.entries(gates)) {
      const file = join(process.argv[3], `${gate}.md`);
      writeFileSync(file, await formatMarkdown(result.text, file));
      console.log(`${gate} ${result.verdict}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'gates could not be rendered');
    process.exitCode = 1;
  }
}
