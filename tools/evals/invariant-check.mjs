import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const requiredInvariants = [
  'SEC-01',
  'SEC-02',
  'SEC-03',
  'SEC-04',
  'DUR-01',
  'DUR-02',
  'DUR-03',
  'GOV-01',
  'OBS-01',
];

const repoRoot = new URL('../../', import.meta.url);
const mapUrl = new URL('tools/evals/invariant-map.json', repoRoot);

export function loadInvariantMap(url = mapUrl) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function isRepoRelative(file) {
  return typeof file === 'string' && !isAbsolute(file) && !normalize(file).startsWith('..');
}

/** Returns problems; empty means every required invariant maps to existing tests. */
export function checkInvariantMap(map, { root = repoRoot, exists = existsSync } = {}) {
  const problems = [];
  const byId = new Map((map?.invariants ?? []).map((item) => [item.id, item]));
  for (const id of requiredInvariants) {
    const item = byId.get(id);
    if (!item) {
      problems.push(`${id}: invariant is not mapped`);
      continue;
    }
    if (!Array.isArray(item.deterministic) || item.deterministic.length === 0)
      problems.push(`${id}: no deterministic test mapped`);
    const files = [
      ...(item.deterministic ?? []),
      ...(item.live?.files ?? []).map((file) => ({ file })),
    ];
    for (const { file } of files) {
      if (!isRepoRelative(file)) problems.push(`${id}: path escapes the repository: ${file}`);
      else if (!exists(fileURLToPath(new URL(file, root))))
        problems.push(`${id}: mapped test file does not exist: ${file}`);
    }
    if (!item.live?.operatorEvidence)
      problems.push(`${id}: no live test or operator evidence named`);
  }
  for (const id of byId.keys())
    if (!requiredInvariants.includes(id)) problems.push(`${id}: unknown invariant`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = checkInvariantMap(loadInvariantMap());
  for (const problem of problems) console.error(problem);
  console.log(problems.length === 0 ? 'invariant map ok' : `${problems.length} problem(s)`);
  process.exitCode = problems.length === 0 ? 0 : 1;
}
