import { canonicalPayloadSha256 } from '@agent-works/domain';
import { z } from 'zod';

const CAPABILITIES = ['sandboxExecution', 'managedMemory'] as const;
export type Capability = (typeof CAPABILITIES)[number];

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmpty = z.string().min(1);

const gateBodySchema = z.strictObject({
  capability: z.enum(CAPABILITIES),
  project: nonEmpty,
  scope: nonEmpty,
  /** Deployed image digest the sign-off was given for. */
  digest: sha256,
  verdict: z.enum(['GO', 'DEFER', 'NO-GO']),
  signedOffBy: nonEmpty,
  approvalRef: nonEmpty,
  signedOffAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

const gateRecordSchema = gateBodySchema.extend({ recordDigest: sha256 });

export type GateRecord = z.infer<typeof gateRecordSchema>;
export type GateContext = {
  readonly capability: Capability;
  readonly project: string;
  readonly scope: string;
  readonly digest: string;
};
export type GateDenial =
  | 'no-record'
  | 'verdict-not-go'
  | 'project-mismatch'
  | 'scope-mismatch'
  | 'digest-mismatch'
  | 'expired'
  | 'tampered';
type GateDecision =
  | { readonly allowed: true; readonly record: GateRecord }
  | { readonly allowed: false; readonly reason: GateDenial };

export class CapabilityDisabledError extends Error {
  constructor(
    readonly capability: Capability,
    readonly reason: GateDenial,
  ) {
    super(`capability ${capability} is disabled: ${reason}`);
    this.name = 'CapabilityDisabledError';
  }
}

/** Seals a record body. The digest detects alteration; it is not a signature. Authenticity comes from loading records only from operator-controlled config. */
export function sealGateRecord(body: z.input<typeof gateBodySchema>): GateRecord {
  const parsed = gateBodySchema.parse(body);
  return { ...parsed, recordDigest: canonicalPayloadSha256(parsed) };
}

export type CapabilityGuard = {
  check(this: void, context: GateContext, now: Date): GateDecision;
};

/**
 * Fail closed. With no records, malformed records, or any mismatch, every capability is denied.
 * Malformed input is dropped, never repaired, so a bad config cannot enable anything.
 */
export function createCapabilityGuard(rawRecords: readonly unknown[] = []): CapabilityGuard {
  const records = rawRecords.flatMap((raw) => {
    const parsed = gateRecordSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });

  return {
    check(context, now) {
      const candidates = records.filter((record) => record.capability === context.capability);
      if (candidates.length === 0) return { allowed: false, reason: 'no-record' };
      let reason: GateDenial = 'verdict-not-go';
      for (const record of candidates) {
        const denial = denialFor(record, context, now);
        if (denial === undefined) return { allowed: true, record };
        reason = denial;
      }
      return { allowed: false, reason };
    },
  };
}

/** Throws unless the guard allows the call. Every capability call path goes through here. */
export function requireCapability(
  guard: CapabilityGuard,
  context: GateContext,
  now: Date,
): GateRecord {
  const decision = guard.check(context, now);
  if (!decision.allowed) throw new CapabilityDisabledError(context.capability, decision.reason);
  return decision.record;
}

function denialFor(record: GateRecord, context: GateContext, now: Date): GateDenial | undefined {
  const { recordDigest, ...body } = record;
  if (canonicalPayloadSha256(body) !== recordDigest) return 'tampered';
  if (record.verdict !== 'GO') return 'verdict-not-go';
  if (record.project !== context.project) return 'project-mismatch';
  if (record.scope !== context.scope) return 'scope-mismatch';
  if (record.digest !== context.digest) return 'digest-mismatch';
  if (Date.parse(record.expiresAt) <= now.getTime()) return 'expired';
  return undefined;
}
