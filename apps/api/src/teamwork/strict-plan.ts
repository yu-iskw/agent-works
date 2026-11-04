import {
  validateProposal,
  parseProposalText,
  DEFAULT_PROPOSAL_POLICY,
} from './coordinator-proposal.js';
import { MAX_PLAN_NODES } from './graph.js';

import type { ProposalVerdict } from './coordinator-proposal.js';
import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';
import type { SourceKind } from '@agent-works/domain/teamwork';

/**
 * The coordinator's parent grant when no standing-grant store backs the segment: it authorizes
 * nothing, so a proposal that asks a node for any grant is refused as widening while a plain plan
 * passes. It exists only to give `validateProposal` its fan-out ceiling. A real parent grant from
 * the standing-grant resolver replaces it once that resolver is wired to this segment.
 */
function inertParentGrant(coordinatorId: string, now: string): StandingGrant {
  return {
    grantId: `inert:${coordinatorId}`,
    issuer: 'system:inert',
    sponsor: 'system:inert',
    grantee: { botId: coordinatorId, botVersion: 1 },
    permissions: [{ action: 'none', resource: 'none' }],
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
    revocation: { status: 'active' },
    parentGrantId: null,
    depth: 0,
    maxDepth: 0,
    schedule: {
      allowed: false,
      minIntervalSeconds: 0,
      maxLifetimeSeconds: 0,
      maxActiveRoutines: 0,
    },
    limits: {
      maxConcurrency: 1,
      maxFanOut: MAX_PLAN_NODES,
      budget: {
        approval: 'PLACEHOLDER',
        estimatedCostMicros: 0,
        inferenceSteps: 0,
        parallelism: 1,
      },
    },
    policyRevision: 'inert',
    auditRef: 'inert',
  };
}

export type StrictPlanInput = {
  readonly coordinatorId: string;
  /** Teammate id to the sources that teammate may be given for this task, already narrowed. */
  readonly roster: ReadonlyMap<string, ReadonlySet<SourceKind>>;
  readonly now: string;
};

/** Validates coordinator text whole: any breach denies the proposal rather than trimming it. */
export function strictPlan(text: string, input: StrictPlanInput): ProposalVerdict {
  return validateProposal(parseProposalText(text), {
    resultOwner: input.coordinatorId,
    roster: new Map(
      [...input.roster].map(([id, sources]) => [id, { version: 1, sources }] as const),
    ),
    parentGrant: inertParentGrant(input.coordinatorId, input.now),
    policy: DEFAULT_PROPOSAL_POLICY,
    now: input.now,
  });
}
