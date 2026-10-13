// @ts-check
/** @typedef {{
  readonly checkedAt: string;
  readonly sourceObjectId: string;
  readonly denied: boolean;
}} RevocationCheck */
/** @typedef {{
  readonly changedAt: string;
  readonly checks: readonly RevocationCheck[];
  readonly revocationLagMs: number | null;
  readonly stable: boolean;
}} RevocationObservation */
/** First of at least two consecutive denied samples. This is a sampled upper bound,
 * not the exact propagation time; callers must keep the polling interval with evidence.
 * An allow after a denial resets stability. Any disclosure remains independently NO-GO. */
/**
 * @param {string} changedAt
 * @param {readonly RevocationCheck[]} checks
 * @returns {RevocationObservation}
 */
export function summarizeRevocation(changedAt, checks) {
  const changed = Date.parse(changedAt);
  if (!Number.isFinite(changed)) throw new Error('invalid change timestamp');
  let previous = changed;
  /** @type {number | null} */
  let firstDenial = null;
  let deniedCount = 0;
  const seen = new Map();
  /** @type {RevocationCheck[]} */
  const samples = [];
  for (const check of checks) {
    const at = Date.parse(check.checkedAt);
    if (!Number.isFinite(at) || at < previous) throw new Error('invalid polling order');
    previous = at;
    const prior = seen.get(at);
    if (prior !== undefined) {
      if (prior !== check.denied) throw new Error('conflicting polling samples');
      continue;
    }
    seen.set(at, check.denied);
    samples.push(check);
    if (check.denied) {
      firstDenial ??= at;
      deniedCount += 1;
    } else {
      firstDenial = null;
      deniedCount = 0;
    }
  }
  const stable = deniedCount >= 2;
  return {
    changedAt,
    checks: samples,
    stable,
    revocationLagMs: stable && firstDenial !== null ? firstDenial - changed : null,
  };
}
