import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { z } from 'zod';

import { compareArms, proposedThresholds } from './evaluate.ts';

/** Read only: callers choose whether and where to redirect the deterministic JSON. */
const thresholdsSchema = z.strictObject({
  status: z.enum(['proposed', 'approved']),
  approvedBy: z.string().nullable(),
  minimumRecall: z.number().min(0).max(1),
  maximumP95LatencyMs: z.number().positive(),
  maximumRevocationLagMs: z.number().nonnegative(),
});

export function runComparison(managedPath: string, drivePath: string, thresholdsPath?: string) {
  const managed: unknown = JSON.parse(readFileSync(managedPath, 'utf8'));
  const drive: unknown = JSON.parse(readFileSync(drivePath, 'utf8'));
  const thresholds = thresholdsPath
    ? thresholdsSchema.parse(JSON.parse(readFileSync(thresholdsPath, 'utf8')) as unknown)
    : proposedThresholds;
  return compareArms(managed, drive, thresholds);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3)
      throw new Error(
        'usage: node spikes/retrieval/compare/run.ts managed.json drive.json [approved-thresholds.json]',
      );
    process.stdout.write(`${JSON.stringify(runComparison(args[0], args[1], args[2]), null, 2)}\n`);
  } catch {
    process.stderr.write('comparison refused: invalid evidence or arguments\n');
    process.exitCode = 1;
  }
}
