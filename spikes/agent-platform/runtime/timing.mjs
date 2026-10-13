// Synthetic diagnostic only. No live timing/cost field is populated from this function.
export function syntheticWarmP95(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.length > 10000)
    throw new Error('Missing bounded timing samples');
  if (
    samples.some(
      (sample) =>
        !sample ||
        sample.provenance !== 'synthetic' ||
        sample.warm !== true ||
        !Number.isFinite(sample.firstTokenMs) ||
        sample.firstTokenMs < 0,
    )
  )
    throw new Error('Invalid synthetic warm timing sample');
  const sorted = samples.map(({ firstTokenMs }) => firstTokenMs).sort((a, b) => a - b);
  return {
    provenance: 'synthetic',
    count: sorted.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    liveValidation: 'UNVERIFIED',
  };
}
