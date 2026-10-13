// @ts-check
/** @typedef {import('../compare/revocation.mjs').RevocationCheck} RevocationCheck */
/** @typedef {{
  readonly changedAt: string;
  readonly sourceObjectId: string;
  readonly attempts: number;
  readonly intervalMs: number;
  readonly recheckDenied: (sourceObjectId: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}} PollOptions */
import { summarizeRevocation } from '../compare/revocation.mjs';
/** Operator-only source revoke/delete polling. No live runner is executed by CI. */
/**
 * @param {PollOptions} options
 */
export async function pollRevocation(options) {
  if (
    !Number.isInteger(options.attempts) ||
    options.attempts < 2 ||
    options.attempts > 120 ||
    !Number.isFinite(options.intervalMs) ||
    options.intervalMs < 1 ||
    options.intervalMs > 60_000
  ) {
    throw new Error('invalid polling budget');
  }
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  /** @type {RevocationCheck[]} */
  const checks = [];
  for (let index = 0; index < options.attempts; index += 1) {
    if (index > 0) await wait(options.intervalMs);
    const denied = await options.recheckDenied(options.sourceObjectId);
    checks.push({
      checkedAt: new Date(now()).toISOString(),
      denied,
      sourceObjectId: options.sourceObjectId,
    });
  }
  return { ...summarizeRevocation(options.changedAt, checks), intervalMs: options.intervalMs };
}
