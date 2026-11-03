const ansi = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Findings that are known to fail on the integration base. They are recorded, never omitted. */
const knownFailing = [
  {
    id: 'osv-scanner/GHSA-g3hv-75wg-m249',
    package: 'minimatch',
    severity: 'medium',
    note: 'minimatch 10.2.5 denial of service via globparts amplification; pnpm-lock.yaml',
  },
];

const fileHeader = /^(\S+?):(\d+):\d+$/;
const issueLine = /^\s*(\d+):\d+\s+(critical|high|medium|low)\s+(.*?)\s{2,}(\S+\/\S+)\s*$/;

/**
 * Parses `pnpm lint:security` output (Trunk, ANSI allowed). Exit code 0 with no findings is the
 * only PASS. Missing output is BLOCKED. A known failing advisory absent from a failing run is
 * still recorded as FAIL with source "known-baseline".
 */
export function parseSecurity({ output, exitCode, command = 'pnpm lint:security' }) {
  const text = typeof output === 'string' ? output.replace(ansi, '') : '';
  const findings = [];
  let file = null;
  for (const line of text.split(/\r?\n/)) {
    const header = fileHeader.exec(line.trim());
    if (header && !line.startsWith(' ')) {
      file = header[1];
      continue;
    }
    const issue = issueLine.exec(line);
    if (issue)
      findings.push({
        id: issue[4],
        file,
        line: Number(issue[1]),
        severity: issue[2],
        message: issue[3],
        source: 'scan-output',
        status: 'FAIL',
      });
  }
  const observed = typeof exitCode === 'number' && text.trim() !== '';
  const failing = !observed || exitCode !== 0;
  if (failing) {
    for (const known of knownFailing)
      if (!findings.some((item) => item.id === known.id))
        findings.push({
          id: known.id,
          file: 'pnpm-lock.yaml',
          line: null,
          severity: known.severity,
          message: known.note,
          source: 'known-baseline',
          status: 'FAIL',
        });
  }
  const status = !observed ? 'BLOCKED' : exitCode === 0 && findings.length === 0 ? 'PASS' : 'FAIL';
  return { command, exitCode: typeof exitCode === 'number' ? exitCode : null, status, findings };
}
