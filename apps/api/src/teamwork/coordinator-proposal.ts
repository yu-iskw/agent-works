import { deriveChildGrant } from '@agent-works/domain/standing-grant-contract';
import { planContentSchema, plannedAssignmentSchema } from '@agent-works/domain/teamwork';
import { hasDependencyCycle } from '@agent-works/domain/teamwork-policy';
import * as z from 'zod';

import { MAX_PLAN_NODES } from './graph.js';

import type { StandingGrant } from '@agent-works/domain/standing-grant-contract';
import type { PlanContent, SourceKind } from '@agent-works/domain/teamwork';

/**
 * Coordinator output is untrusted text from a model that read untrusted documents. Nothing in it is
 * authority. This file turns it into a plan the member can review, or into a list of reasons it was
 * refused. It never trims: a proposal that asks for more than the rules allow is denied whole, so
 * the same input always gives the same verdict and an injected request leaves no partial plan.
 *
 * Even an accepted proposal only becomes a `proposed` plan. Approval stays with the member and the
 * grants a node may use are derived from the parent grant, never read from the proposal.
 */

export type ProposalPolicy = {
  /** Most nodes a plan may hold. Never above the stored plan limit. */
  readonly maxNodes: number;
  /** Most nodes that may wait on one node. */
  readonly maxFanOut: number;
  /** Most nodes on one dependency chain. */
  readonly maxDepth: number;
};

export const DEFAULT_PROPOSAL_POLICY: ProposalPolicy = {
  maxNodes: MAX_PLAN_NODES,
  maxFanOut: 3,
  maxDepth: 3,
};

type RosterBot = {
  readonly version: number;
  /** Sources this bot may be given for this task, already narrowed by policy. */
  readonly sources: ReadonlySet<SourceKind>;
};

export type ProposalContext = {
  /** The coordinator's own teammate. A proposal may not hand the result to another bot. */
  readonly resultOwner: string;
  /** Only bots the member owns and policy allows for this task. */
  readonly roster: ReadonlyMap<string, RosterBot>;
  /** The coordinator's usable grant. Child grants are derived from it by intersection only. */
  readonly parentGrant: StandingGrant;
  readonly policy: ProposalPolicy;
  readonly now: string;
};

const REASON_ORDER = [
  'schema',
  'approval_bypass',
  'wrong_result_owner',
  'duplicate_key',
  'unknown_bot',
  'unauthorized_source',
  'dangling_edge',
  'cycle',
  'node_cap',
  'fan_out',
  'depth',
  'grant_widening',
  'grant_denied',
] as const;
type ProposalReason = (typeof REASON_ORDER)[number];

type ProposalFinding = { readonly reason: ProposalReason; readonly key: string | null };

export type ProposalVerdict =
  | {
      readonly ok: true;
      readonly content: PlanContent;
      /** Derived, usable grant per node that asked for authority. Nodes that did not ask hold none. */
      readonly childGrants: ReadonlyMap<string, StandingGrant>;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly ProposalReason[];
      readonly findings: readonly ProposalFinding[];
    };

const label = z.string().min(1).max(200);
/** Bounds parsing only; the node cap is a policy verdict, not a parse failure. */
const PARSE_NODE_LIMIT = 64;

const proposedNodeSchema = plannedAssignmentSchema.extend({
  grants: z
    .array(z.strictObject({ capability: label, resource: label }))
    .max(32)
    .optional(),
});

const proposalSchema = z.strictObject({
  summary: planContentSchema.shape.summary,
  assignments: z.array(proposedNodeSchema).min(1).max(PARSE_NODE_LIMIT),
  synthesisOwner: z.string().optional(),
  expectedEffects: planContentSchema.shape.expectedEffects,
});

const APPROVAL_WORDS = /approv|bypass|skip|auto|confirm|override|sudo|admin|elevat|privilege/i;

/** Parses model text as JSON, with or without a code fence. Anything else is `undefined`. */
export function parseProposalText(text: string): unknown {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

type Node = z.infer<typeof proposedNodeSchema>;

function longestChain(nodes: readonly Node[]): number {
  const deps = new Map(nodes.map((node) => [node.key, node.dependsOn]));
  const memo = new Map<string, number>();
  const length = (key: string): number => {
    const known = memo.get(key);
    if (known !== undefined) return known;
    const value = 1 + Math.max(0, ...(deps.get(key) ?? []).map(length));
    memo.set(key, value);
    return value;
  };
  return Math.max(0, ...nodes.map((node) => length(node.key)));
}

function mostDependents(nodes: readonly Node[]): { key: string; count: number } {
  const counts = new Map<string, number>();
  for (const node of nodes)
    for (const key of new Set(node.dependsOn)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).at(0);
  return top === undefined ? { key: '', count: 0 } : { key: top[0], count: top[1] };
}

const GRANT_REASONS = new Map<string, ProposalReason>([
  ['permission_widened', 'grant_widening'],
  ['depth_exceeded', 'depth'],
]);

function deriveNodeGrant(
  node: Node,
  bot: RosterBot,
  ctx: ProposalContext,
): { grant: StandingGrant } | { reasons: ProposalReason[] } {
  const parent = ctx.parentGrant;
  const result = deriveChildGrant(
    parent,
    {
      grantId: `${parent.grantId}:${node.key}`,
      grantee: { botId: node.teammateId, botVersion: bot.version },
      permissions: (node.grants ?? []).map((grant) => ({
        action: grant.capability,
        resource: grant.resource,
      })),
      issuedAt: ctx.now,
      expiresAt: parent.expiresAt,
      maxDepth: parent.maxDepth,
      schedule: {
        allowed: false,
        minIntervalSeconds: 0,
        maxLifetimeSeconds: 0,
        maxActiveRoutines: 0,
      },
      limits: { maxConcurrency: 1, maxFanOut: 0, budget: parent.limits.budget },
      auditRef: `${parent.auditRef}:${node.key}`,
    },
    ctx.now,
  );
  if (result.ok) return { grant: result.grant };
  return { reasons: result.reasons.map((reason) => GRANT_REASONS.get(reason) ?? 'grant_denied') };
}

const finding = (reason: ProposalReason, key: string | null = null): ProposalFinding => ({
  reason,
  key,
});

function refusal(findings: readonly ProposalFinding[]): ProposalVerdict {
  const unique = new Map(findings.map((f) => [`${f.reason}\u0000${f.key ?? ''}`, f]));
  const ordered = [...unique.values()].sort(
    (a, b) =>
      REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason) ||
      (a.key ?? '').localeCompare(b.key ?? ''),
  );
  return {
    ok: false,
    reasons: REASON_ORDER.filter((reason) => ordered.some((f) => f.reason === reason)),
    findings: ordered,
  };
}

function schemaFindings(error: z.ZodError): ProposalFinding[] {
  const bypass = error.issues.some(
    (issue) =>
      issue.code === 'unrecognized_keys' && issue.keys.some((key) => APPROVAL_WORDS.test(key)),
  );
  return bypass ? [finding('schema'), finding('approval_bypass')] : [finding('schema')];
}

function rosterFindings(nodes: readonly Node[], ctx: ProposalContext): ProposalFinding[] {
  return nodes.flatMap((node) => {
    const bot = ctx.roster.get(node.teammateId);
    if (bot === undefined) return [finding('unknown_bot', node.key)];
    return node.sources.some((source) => !bot.sources.has(source))
      ? [finding('unauthorized_source', node.key)]
      : [];
  });
}

/** Shape rules. Chain and fan-out are only measured on a graph that is sound. */
function graphFindings(nodes: readonly Node[], policy: ProposalPolicy): ProposalFinding[] {
  const keys = new Set(nodes.map((node) => node.key));
  const duplicates = nodes.length !== keys.size;
  const found: ProposalFinding[] = [];
  const counted = new Set<string>();
  for (const node of nodes) {
    if (counted.has(node.key)) found.push(finding('duplicate_key', node.key));
    counted.add(node.key);
    if (node.dependsOn.some((key) => !keys.has(key)))
      found.push(finding('dangling_edge', node.key));
  }
  if (duplicates || found.length > 0) return found;
  if (hasDependencyCycle(nodes)) return [finding('cycle')];
  const busiest = mostDependents(nodes);
  if (busiest.count > policy.maxFanOut) found.push(finding('fan_out', busiest.key));
  if (longestChain(nodes) > policy.maxDepth) found.push(finding('depth'));
  return found;
}

function grantFindings(
  nodes: readonly Node[],
  ctx: ProposalContext,
): { findings: ProposalFinding[]; grants: Map<string, StandingGrant> } {
  const findings: ProposalFinding[] = [];
  const grants = new Map<string, StandingGrant>();
  for (const node of nodes) {
    const bot = ctx.roster.get(node.teammateId);
    if (bot === undefined || (node.grants ?? []).length === 0) continue;
    const derived = deriveNodeGrant(node, bot, ctx);
    if ('grant' in derived) grants.set(node.key, derived.grant);
    else findings.push(...derived.reasons.map((reason) => finding(reason, node.key)));
  }
  return { findings, grants };
}

export function validateProposal(raw: unknown, ctx: ProposalContext): ProposalVerdict {
  const parsed = proposalSchema.safeParse(raw);
  if (!parsed.success) return refusal(schemaFindings(parsed.error));
  const proposal = parsed.data;
  const nodes: Node[] = proposal.assignments;
  const maxNodes = Math.min(ctx.policy.maxNodes, MAX_PLAN_NODES, ctx.parentGrant.limits.maxFanOut);
  const owned =
    proposal.synthesisOwner === undefined || proposal.synthesisOwner === ctx.resultOwner;
  const { findings: grantProblems, grants } = grantFindings(nodes, ctx);
  const findings = [
    ...(owned ? [] : [finding('wrong_result_owner')]),
    ...(nodes.length > maxNodes ? [finding('node_cap')] : []),
    ...rosterFindings(nodes, ctx),
    ...graphFindings(nodes, ctx.policy),
    ...grantProblems,
  ];
  if (findings.length > 0) return refusal(findings);
  const content = planContentSchema.safeParse({
    summary: proposal.summary,
    assignments: nodes.map(({ grants: _grants, ...node }) => node),
    synthesisOwner: ctx.resultOwner,
    expectedEffects: proposal.expectedEffects,
  });
  return content.success
    ? { ok: true, content: content.data, childGrants: grants }
    : refusal(schemaFindings(content.error));
}
