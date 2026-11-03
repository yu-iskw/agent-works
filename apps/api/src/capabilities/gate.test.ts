import { describe, expect, it } from 'vitest';

import {
  CapabilityDisabledError,
  createCapabilityGuard,
  requireCapability,
  sealGateRecord,
} from './gate.js';

import type { GateContext } from './gate.js';

const now = new Date('2026-11-03T00:00:00Z');
const context: GateContext = {
  capability: 'sandboxExecution',
  project: 'proj-a',
  scope: 'team-x',
  digest: 'b'.repeat(64),
};
const body = {
  capability: 'sandboxExecution' as const,
  project: 'proj-a',
  scope: 'team-x',
  digest: 'b'.repeat(64),
  verdict: 'GO' as const,
  signedOffBy: 'operator@example.test',
  approvalRef: 'GATE-1',
  signedOffAt: '2026-11-02T00:00:00Z',
  expiresAt: '2026-12-01T00:00:00Z',
};

describe('capability guard', () => {
  it('denies every capability when no record exists', () => {
    const guard = createCapabilityGuard();
    for (const capability of ['sandboxExecution', 'managedMemory'] as const) {
      expect(guard.check({ ...context, capability }, now)).toEqual({
        allowed: false,
        reason: 'no-record',
      });
    }
    expect(() => requireCapability(guard, context, now)).toThrow(CapabilityDisabledError);
  });

  it('allows only the exact project, scope, digest and capability of a GO record', () => {
    const guard = createCapabilityGuard([sealGateRecord(body)]);
    expect(guard.check(context, now).allowed).toBe(true);
    const denied = (patch: Partial<GateContext>): unknown =>
      guard.check({ ...context, ...patch }, now);
    expect(denied({ project: 'proj-b' })).toMatchObject({ reason: 'project-mismatch' });
    expect(denied({ scope: 'team-y' })).toMatchObject({ reason: 'scope-mismatch' });
    expect(denied({ digest: 'c'.repeat(64) })).toMatchObject({ reason: 'digest-mismatch' });
    expect(denied({ capability: 'managedMemory' })).toMatchObject({ reason: 'no-record' });
  });

  it('denies DEFER and NO-GO records, expired records and tampered records', () => {
    for (const verdict of ['DEFER', 'NO-GO'] as const) {
      const guard = createCapabilityGuard([sealGateRecord({ ...body, verdict })]);
      expect(guard.check(context, now)).toEqual({ allowed: false, reason: 'verdict-not-go' });
    }
    const expired = createCapabilityGuard([sealGateRecord(body)]);
    expect(expired.check(context, new Date('2027-01-01T00:00:00Z'))).toEqual({
      allowed: false,
      reason: 'expired',
    });
    const tampered = { ...sealGateRecord({ ...body, verdict: 'DEFER' }), verdict: 'GO' };
    expect(createCapabilityGuard([tampered]).check(context, now)).toEqual({
      allowed: false,
      reason: 'tampered',
    });
  });

  it('drops malformed records instead of repairing them', () => {
    const guard = createCapabilityGuard([{ ...sealGateRecord(body), extra: 1 }, 'x', null, {}]);
    expect(guard.check(context, now)).toEqual({ allowed: false, reason: 'no-record' });
  });
});
