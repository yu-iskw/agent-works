import { evaluateGate } from './gate.mjs';

/**
 * Turns an offline score report into binding results. Security counters become a
 * security result; quality floors stay UNTESTED until an owner approves thresholds.
 */
export function offlineEvalResults(scoreReport, gateConfig) {
  const gate = evaluateGate(scoreReport, gateConfig);
  const securityFailed = gate.failures.some(
    (item) => item.startsWith('security:') || item === 'invalid-evidence',
  );
  const qualityFailed = gate.failures.some(
    (item) => !item.startsWith('security:') && item !== 'invalid-evidence',
  );
  const base = { label: 'offline', provenance: 'offline-fixture', ref: 'offline-eval' };
  const approved = gateConfig.thresholdStatus === 'APPROVED';
  return [
    {
      ...base,
      id: 'security:offline-eval',
      kind: 'security',
      status: securityFailed ? 'FAIL' : 'PASS',
    },
    {
      ...base,
      id: 'quality:offline-eval',
      kind: 'quality',
      status: !approved ? 'UNTESTED' : qualityFailed ? 'FAIL' : 'PASS',
      ref: approved ? 'offline-eval' : 'thresholds are unapproved placeholders',
    },
  ];
}

/**
 * Verdict precedence: a security failure is NO-GO whatever the quality numbers say;
 * missing mandatory evidence is AWAITING_EVIDENCE; quality is consulted last and can
 * only add a failure, never offset one.
 */
export function evaluateStageGate(report, { approvers = [] } = {}) {
  const reasons = [];
  const securityFailures = report.results.filter(
    (item) => item.kind === 'security' && item.status === 'FAIL',
  );
  const qualityFailures = report.results.filter(
    (item) => item.kind === 'quality' && item.status === 'FAIL',
  );
  const missing = report.results.filter(
    (item) =>
      item.status === 'UNTESTED' ||
      (item.status === 'DEFER' && !(item.optional && item.deferReason)),
  );
  for (const item of securityFailures) reasons.push(`security failure: ${item.id}`);
  for (const item of missing) reasons.push(`missing evidence: ${item.id}`);
  for (const name of report.missingBindings) reasons.push(`missing binding: ${name}`);
  if (approvers.length === 0) reasons.push('missing owner approval');
  for (const item of qualityFailures) reasons.push(`quality failure: ${item.id}`);
  let verdict = 'GO';
  if (securityFailures.length > 0) verdict = 'NO-GO';
  else if (missing.length > 0 || report.missingBindings.length > 0 || approvers.length === 0)
    verdict = 'AWAITING_EVIDENCE';
  else if (qualityFailures.length > 0) verdict = 'NO-GO';
  return { verdict, reasons };
}

const cell = (value) => (value ?? 'none').toString().replaceAll('|', '/');

/** Fills templates/stage-gate.md. Unknown fields print as UNTESTED, never blank. */
export function renderStageGate(
  report,
  decision,
  {
    gate = 'UNTESTED',
    environment,
    dates,
    version,
    migrations,
    policyRevision,
    approvers = [],
  } = {},
) {
  const rows = report.results.map(
    (item) =>
      `| ${item.id} (${item.label}) | ${cell(item.ref)} | ${item.status} | ${cell(item.owner)} |`,
  );
  const securityLines = report.results
    .filter((item) => item.kind === 'security')
    .map((item) => `${item.id}: ${item.status}`);
  const deferred = report.results.filter((item) => item.status === 'DEFER');
  return [
    '# Stage release gate',
    '',
    `- Gate G1/G2/G3/G4: ${gate}`,
    `- Candidate source SHA / image digests / migrations / policy/config revisions: ${report.sourceSha} / ${report.imageDigests.join(', ') || 'UNTESTED'} / ${migrations ?? 'UNTESTED'} / ${policyRevision ?? 'UNTESTED'}`,
    `- Environment and tested dates: ${environment ?? 'UNTESTED'} / ${dates ?? 'UNTESTED'}`,
    `- Applicable acceptance IDs and target version: SEC-01..04, DUR-01..03, GOV-01, OBS-01 / ${version ?? 'UNTESTED'}`,
    `- Model / dataset / judge: ${report.model ? `${report.model.name} ${report.model.version}` : 'UNTESTED'} / ${report.dataset.version} / ${report.judge ? JSON.stringify(report.judge) : 'UNTESTED'}`,
    '',
    '| Requirement | Evidence | Status | Owner |',
    '|---|---|---|---|',
    ...rows,
    '',
    `- Security negative results and positive controls: ${securityLines.join('; ') || 'UNTESTED'}`,
    '- Reliability and performance sample sizes/results: UNTESTED',
    `- Optional deferred capabilities and proof disabled: ${deferred.map((item) => `${item.id} (${item.deferReason})`).join('; ') || 'none'}`,
    '- Residual risks, owner and expiry: UNTESTED',
    '- Recovery/rollback evidence: UNTESTED',
    `- Approvers and date: ${approvers.join(', ') || 'UNTESTED'}`,
    `- Verdict: ${decision.verdict}`,
    '',
    ...(decision.reasons.length > 0
      ? ['Blocking reasons:', ...decision.reasons.map((r) => `- ${r}`)]
      : []),
    '',
  ].join('\n');
}
