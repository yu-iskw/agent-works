// node scripts/ops-04/run.mjs [spec.json] [--out dir]
// Runs the local synthetic campaign against a disposable local Postgres container and writes a
// new versioned result file. Existing results are never overwritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHarness } from './harness.mjs';

export async function runCampaign(args) {
  const outIndex = args.indexOf('--out');
  const outDir = resolve(
    outIndex >= 0 ? args[outIndex + 1] : 'docs/plans/enterprise-production-v1/ops-04/results',
  );
  const specPath = resolve(
    args.find((a, i) => !a.startsWith('--') && i !== outIndex + 1) ??
      fileURLToPath(new URL('workload-local-scaled.json', import.meta.url)),
  );
  const result = await runHarness(JSON.parse(readFileSync(specPath, 'utf8')));
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${result.runId}.json`);
  if (existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
  return { result, file };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { result, file } = await runCampaign(process.argv.slice(2));
  const v = result.evaluation;
  const i = result.metrics.integrity;
  process.stdout.write(
    `${result.label} ${result.specName} -> ${file}\n` +
      `loss=${i.loss.total} dupRemote=${i.duplicateRemoteWrites} uncertainEver=${i.uncertainEffectsEver} unresolved=${i.uncertainEffectsUnresolvedAtEnd}\n` +
      `P02 ${v.P02.verdict} P03 ${v.P03.verdict} P04 ${v.P04.verdict} P05 ${v.P05.verdict}\n`,
  );
  process.exit(0);
}
