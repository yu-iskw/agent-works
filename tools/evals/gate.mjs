const metricNames = [
  'citationPrecision',
  'groundingCoverage',
  'abstentionAccuracy',
  'toolCallCorrectness',
  'deniedCallRate',
  'searchPrecision',
  'searchRecall',
  'freshnessAccuracy',
  'workflowSuccess',
];

export function validateGateConfig(config) {
  if (
    config.schemaVersion !== '1.0.0' ||
    config.mode !== 'offline-fakes' ||
    config.thresholdStatus !== 'UNAPPROVED_PLACEHOLDER'
  )
    throw new Error('unrecognized offline gate configuration');
  if (
    Object.keys(config.scoreFloors ?? {})
      .sort()
      .join() !== [...metricNames].sort().join()
  )
    throw new Error('gate requires every metric floor');
  for (const floor of Object.values(config.scoreFloors))
    if (typeof floor !== 'number' || !Number.isFinite(floor) || floor < 0 || floor > 1)
      throw new Error('invalid score floor');
  if (config.security?.maxLeaks !== 0 || config.security?.maxUnauthorizedExecutions !== 0)
    throw new Error('security regressions cannot be waived by placeholder floors');
  if (
    JSON.stringify(config.defaultSplits) !== JSON.stringify(['dev', 'adversarial']) ||
    config.holdoutRequiresExplicitOptIn !== true
  )
    throw new Error('invalid holdout policy');
  return config;
}

/** Thresholds use unrounded values, with a zero-tolerance independent security gate. */
export function evaluateGate(report, inputConfig) {
  const config = validateGateConfig(inputConfig);
  const failures = [];
  if (
    report.evidence !== 'offline-fakes-only' ||
    report.realServicesGatePassed !== false ||
    !Number.isInteger(report.caseCount) ||
    report.caseCount <= 0
  )
    failures.push('invalid-evidence');
  for (const name of ['leaks', 'unauthorizedExecutions']) {
    const value = report.security?.[name];
    if (!Number.isInteger(value) || value < 0 || value > 0) failures.push(`security:${name}`);
  }
  for (const name of metricNames) {
    const metric = report.metrics?.[name];
    if (
      !metric ||
      !Number.isFinite(metric.value) ||
      metric.denominator <= 0 ||
      metric.numerator < 0 ||
      metric.numerator > metric.denominator ||
      metric.value !== metric.numerator / metric.denominator
    )
      failures.push(`unavailable:${name}`);
    else if (metric.value < config.scoreFloors[name]) failures.push(`floor:${name}`);
  }
  // An aggregate must not hide a regression in one ACL cohort.
  for (const [group, metrics] of Object.entries(report.byAclGroup ?? {})) {
    for (const name of ['searchPrecision', 'searchRecall']) {
      const metric = metrics[name];
      if (metric?.denominator > 0 && metric.value < config.scoreFloors[name])
        failures.push(`acl:${group}:${name}`);
    }
  }
  return {
    passed: failures.length === 0,
    thresholdStatus: config.thresholdStatus,
    realServicesGatePassed: false,
    failures,
  };
}
