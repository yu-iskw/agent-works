// @ts-check

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { compareArms, proposedThresholds } from './evaluate.mjs';
/** Read only: callers choose whether and where to redirect the deterministic JSON. */
const thresholdsSchema = z.strictObject({
  status: z.enum(['proposed', 'approved']),
  approvedBy: z.string().nullable(),
  minimumRecall: z.number().min(0).max(1),
  maximumP95LatencyMs: z.number().positive(),
  maximumRevocationLagMs: z.number().nonnegative(),
});
/**
 * @param {string} managedPath
 * @param {string} drivePath
 * @param {string} [thresholdsPath]
 */
export function runComparison(managedPath, drivePath, thresholdsPath) {
  /** @type {unknown} */
  // Explicit operator CLI evidence path in this read-only runner.
  const managed = JSON.parse(readFileSync(managedPath, 'utf8'));
  /** @type {unknown} */
  const drive = JSON.parse(readFileSync(drivePath, 'utf8'));
  let thresholds = proposedThresholds;
  if (thresholdsPath) {
    const raw = readFileSync(thresholdsPath, 'utf8');
    thresholds = thresholdsSchema.parse(JSON.parse(raw));
  }
  return compareArms(managed, drive, thresholds);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2 || args.length > 3)
      throw new Error(
        'usage: node spikes/retrieval/compare/run.mjs managed.json drive.json [approved-thresholds.json]',
      );
    process.stdout.write(`${JSON.stringify(runComparison(args[0], args[1], args[2]), null, 2)}\n`);
  } catch {
    process.stderr.write('comparison refused: invalid evidence or arguments\n');
    process.exitCode = 1;
  }
}
