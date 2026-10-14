import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

import { evaluateGate, validateGateConfig } from './gate.mjs';

const config = JSON.parse(
  readFileSync(new URL('../../evals/gate-config.json', import.meta.url), 'utf8'),
);
function report() {
  return {
    evidence: 'offline-fakes-only',
    realServicesGatePassed: false,
    caseCount: 10,
    security: { leaks: 0, unauthorizedExecutions: 0 },
    metrics: Object.fromEntries(
      Object.keys(config.scoreFloors).map((name) => [
        name,
        { numerator: 10, denominator: 10, value: 1 },
      ]),
    ),
    byAclGroup: {},
  };
}

test('perfect report passes only the unapproved offline gate', () => {
  expect(evaluateGate(report(), config)).toEqual({
    passed: true,
    thresholdStatus: 'UNAPPROVED_PLACEHOLDER',
    realServicesGatePassed: false,
    failures: [],
  });
});

test.each(Object.keys(config.scoreFloors))(
  'each metric independently blocks below its floor: %s',
  (name) => {
    const value = report();
    value.metrics[name] = { numerator: 0, denominator: 10, value: 0 };
    expect(evaluateGate(value, config).failures).toContain(`floor:${name}`);
  },
);

test.each(Object.keys(config.scoreFloors))('missing denominators cannot pass: %s', (name) => {
  const value = report();
  value.metrics[name] = { numerator: 0, denominator: 0, value: null };
  expect(evaluateGate(value, config).failures).toContain(`unavailable:${name}`);
});

test.each(['leaks', 'unauthorizedExecutions'])(
  'one security regression blocks independently of quality floors: %s',
  (name) => {
    const value = report();
    value.security[name] = 1;
    const relaxed = structuredClone(config);
    for (const metric of Object.keys(relaxed.scoreFloors)) relaxed.scoreFloors[metric] = 0;
    expect(evaluateGate(value, relaxed).failures).toContain(`security:${name}`);
  },
);

test('threshold comparison does not round just-below-floor scores', () => {
  const value = report();
  value.metrics.citationPrecision = { numerator: 79999, denominator: 100000, value: 0.79999 };
  expect(evaluateGate(value, config).passed).toBe(false);
  value.metrics.citationPrecision = { numerator: 8, denominator: 10, value: 0.8 };
  expect(evaluateGate(value, config).passed).toBe(true);
});

test('a weak ACL cohort cannot hide behind aggregate precision', () => {
  const value = report();
  value.byAclGroup.people = {
    searchPrecision: { numerator: 1, denominator: 10, value: 0.1 },
    searchRecall: { numerator: 10, denominator: 10, value: 1 },
  };
  expect(evaluateGate(value, config).failures).toContain('acl:people:searchPrecision');
});

test.each([NaN, Infinity, -1, 1.01, '0.8', null])('invalid floor fails closed: %s', (floor) => {
  const value = structuredClone(config);
  value.scoreFloors.citationPrecision = floor;
  expect(() => validateGateConfig(value)).toThrow();
});

test('configuration cannot waive security or imply business approval', () => {
  expect(() => validateGateConfig({ ...config, thresholdStatus: 'APPROVED' })).toThrow();
  expect(() =>
    validateGateConfig({ ...config, security: { maxLeaks: 1, maxUnauthorizedExecutions: 0 } }),
  ).toThrow();
  expect(() => validateGateConfig({ ...config, defaultSplits: ['holdout'] })).toThrow();
  expect(() => validateGateConfig({ ...config, scoreFloors: {} })).toThrow();
  expect(() => validateGateConfig({ ...config, mode: 'live' })).toThrow();
});

test('inconsistent reported values and missing security counters fail closed', () => {
  const value = report();
  value.metrics.searchRecall.value = 0.9;
  delete value.security.leaks;
  expect(evaluateGate(value, config).failures).toEqual(
    expect.arrayContaining(['unavailable:searchRecall', 'security:leaks']),
  );
});
