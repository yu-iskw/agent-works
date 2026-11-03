/* eslint-disable max-nested-callbacks, security/detect-object-injection -- table-driven exhaustive checks */
import { describe, expect, it } from 'vitest';

import {
  ASSIGNMENT_STATUS_LOGICAL,
  GRAPH_CONTRACT_VERSION,
  graphCasSchema,
  graphRevisionSchema,
  nodeReasonSchema,
  nodeStateSchema,
  CAS_OUTCOMES,
  KNOWN_ASSIGNMENT_DIVERGENCES,
  NODE_REASONS,
  NODE_STATES,
  NODE_STATE_TRANSITIONS,
  REASONS_FOR_STATE,
  STAGE_STATUS_LOGICAL,
  TERMINAL_NODE_STATES,
  canNodeTransition,
  evaluateGraphCas,
  graphMutationSchema,
  graphProjectionSchema,
  isNewerProjection,
  logicalNodeState,
  projectionNodeSchema,
  reasonFor,
  visibleNodes,
} from './teamwork-graph-contract.js';
import {
  FIXTURE_DIGEST,
  FIXTURE_NOW,
  FIXTURE_TASK_ID,
  nodeFacts,
  projectionFixture,
  projectionNode,
  revisionFixture,
} from './teamwork-graph-fixtures.js';
import {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TRANSITIONS,
  TEAMWORK_STATUSES,
  taskDetailSchema,
} from './teamwork.js';

import type { NodeState } from './teamwork-graph-contract.js';
import type { AssignmentStatus } from './teamwork.js';

const LEGAL: readonly (readonly [NodeState, NodeState])[] = [
  ['blocked', 'ready'],
  ['blocked', 'cancelled'],
  ['ready', 'running'],
  ['ready', 'blocked'],
  ['ready', 'cancelled'],
  ['running', 'succeeded'],
  ['running', 'retry_wait'],
  ['running', 'failed'],
  ['running', 'awaiting_approval'],
  ['running', 'uncertain'],
  ['running', 'cancelled'],
  ['running', 'ready'],
  ['retry_wait', 'ready'],
  ['retry_wait', 'failed'],
  ['retry_wait', 'cancelled'],
  ['awaiting_approval', 'ready'],
  ['awaiting_approval', 'cancelled'],
  ['awaiting_approval', 'failed'],
  ['uncertain', 'succeeded'],
  ['uncertain', 'failed'],
  ['uncertain', 'running'],
  ['failed', 'ready'],
  ['failed', 'cancelled'],
];

describe('node state transition table', () => {
  it('allows exactly the frozen edges and rejects every other pair', () => {
    const accepted = NODE_STATES.flatMap((from) =>
      NODE_STATES.filter((to) => canNodeTransition(from, to)).map((to) => `${from}>${to}`),
    );
    expect(accepted.sort()).toEqual(LEGAL.map(([from, to]) => `${from}>${to}`).sort());
  });

  it('never leaves a completed effect or a cancellation', () => {
    const leaving = Object.entries(NODE_STATE_TRANSITIONS)
      .filter(([state]) => TERMINAL_NODE_STATES.has(state as NodeState))
      .map(([, targets]) => targets);
    expect(leaving).toEqual([[], []]);
  });

  it('never claims a node that is not ready, and never replays an uncertain effect', () => {
    for (const from of NODE_STATES.filter((s) => s !== 'ready' && s !== 'uncertain'))
      expect(canNodeTransition(from, 'running')).toBe(false);
    expect(canNodeTransition('uncertain', 'ready')).toBe(false);
    expect(canNodeTransition('succeeded', 'ready')).toBe(false);
  });

  it('is total and closed over the nine states', () => {
    expect(Object.keys(NODE_STATE_TRANSITIONS).sort()).toEqual([...NODE_STATES].sort());
    const targets = Object.values(NODE_STATE_TRANSITIONS).flat();
    expect(targets.filter((to) => !NODE_STATES.includes(to))).toEqual([]);
  });
});

describe('mapping onto existing assignment and task names', () => {
  it('maps every stored assignment status and no extra', () => {
    expect(Object.keys(ASSIGNMENT_STATUS_LOGICAL).sort()).toEqual([...ASSIGNMENT_STATUSES].sort());
    const mapped = Object.values(ASSIGNMENT_STATUS_LOGICAL).flat();
    expect(mapped.filter((state) => !NODE_STATES.includes(state))).toEqual([]);
  });

  it('covers every logical state from some stored name', () => {
    const stored = new Set<NodeState>([
      ...Object.values(ASSIGNMENT_STATUS_LOGICAL).flat(),
      ...Object.values(STAGE_STATUS_LOGICAL),
    ]);
    expect([...NODE_STATES].filter((s) => !stored.has(s))).toEqual([]);
    for (const status of Object.keys(STAGE_STATUS_LOGICAL))
      expect(TEAMWORK_STATUSES).toContain(status);
  });

  it('agrees with ASSIGNMENT_TRANSITIONS except for the documented divergences', () => {
    const fits = (from: AssignmentStatus, to: AssignmentStatus): boolean => {
      const sources = ASSIGNMENT_STATUS_LOGICAL[from];
      const targets = ASSIGNMENT_STATUS_LOGICAL[to];
      // A superseded row belongs to an earlier graph revision; it is retired, not moved.
      if (sources.length === 0 || targets.length === 0) return true;
      return sources.some((a) => targets.some((b) => a === b || canNodeTransition(a, b)));
    };
    const diverging = Object.entries(ASSIGNMENT_TRANSITIONS).flatMap(([from, targets]) =>
      targets.filter((to) => !fits(from as AssignmentStatus, to)).map((to) => `${from}>${to}`),
    );
    expect(diverging.sort()).toEqual(
      KNOWN_ASSIGNMENT_DIVERGENCES.map(([a, b]) => `${a}>${b}`).sort(),
    );
  });

  it('derives the logical state from stored facts, never storing a new status', () => {
    const cases: [Partial<Parameters<typeof nodeFacts>[0]>, NodeState | null][] = [
      [{ status: 'queued', dependenciesSatisfied: false }, 'blocked'],
      [{ status: 'queued' }, 'ready'],
      [{ status: 'queued', retryNotBefore: '2026-11-03T00:05:00.000Z' }, 'retry_wait'],
      [{ status: 'queued', retryNotBefore: '2026-11-02T23:00:00.000Z' }, 'ready'],
      [{ status: 'running' }, 'running'],
      [{ status: 'running', effectUnconfirmed: true }, 'uncertain'],
      [{ status: 'needs_input' }, 'awaiting_approval'],
      [{ status: 'succeeded' }, 'succeeded'],
      [{ status: 'failed' }, 'failed'],
      [{ status: 'timed_out' }, 'failed'],
      [{ status: 'failed', errorCode: 'dependency_failed' }, 'blocked'],
      [{ status: 'failed', effectUnconfirmed: true }, 'uncertain'],
      [{ status: 'cancelled' }, 'cancelled'],
      [{ status: 'superseded' }, null],
    ];
    expect(cases.map(([overrides]) => logicalNodeState(nodeFacts(overrides)))).toEqual(
      cases.map(([, expected]) => expected),
    );
  });

  it('only returns states the status table allows, for every status and fact combination', () => {
    const flags = [true, false];
    const combos = ASSIGNMENT_STATUSES.flatMap((status) =>
      flags.flatMap((dependenciesSatisfied) =>
        flags.flatMap((effectUnconfirmed) =>
          [null, 'dependency_failed', 'source_denied'].flatMap((errorCode) =>
            [null, '2026-11-04T00:00:00.000Z'].map((retryNotBefore) =>
              nodeFacts({
                status,
                dependenciesSatisfied,
                effectUnconfirmed,
                errorCode,
                retryNotBefore,
              }),
            ),
          ),
        ),
      ),
    );
    const outside = combos.filter((facts) => {
      const state = logicalNodeState(facts);
      const allowed = ASSIGNMENT_STATUS_LOGICAL[facts.status];
      return state === null ? allowed.length > 0 : !allowed.includes(state);
    });
    expect(outside).toEqual([]);
  });

  it('gives blocked a failed-prerequisite reason distinct from a pending one', () => {
    const pending = nodeFacts({ dependenciesSatisfied: false });
    const failed = nodeFacts({ status: 'failed', errorCode: 'dependency_failed' });
    expect(reasonFor('blocked', pending)).toBe('prerequisite_pending');
    expect(reasonFor('blocked', failed)).toBe('prerequisite_failed');
    expect(reasonFor('ready', pending)).toBeNull();
  });

  it('keeps every reason attached to exactly one kind of state', () => {
    const owners = NODE_REASONS.map(
      (reason) => NODE_STATES.filter((state) => REASONS_FOR_STATE[state].includes(reason)).length,
    );
    expect(owners).toEqual(NODE_REASONS.map(() => 1));
  });

  it('pins that the shipped task detail carries no edges or graph revision today', () => {
    const assignment = taskDetailSchema.shape.assignments.element.shape;
    expect(Object.keys(assignment)).not.toContain('dependsOn');
    expect(Object.keys(taskDetailSchema.shape)).not.toContain('serverRevision');
  });
});

describe('graph revision compare-and-swap', () => {
  const request = {
    taskId: FIXTURE_TASK_ID,
    baseRevision: revisionFixture.revision,
    expectedDigest: FIXTURE_DIGEST,
  };

  it('applies only to the current, live revision with the same digest', () => {
    expect(evaluateGraphCas(revisionFixture, request)).toBe('apply');
    expect(evaluateGraphCas({ ...revisionFixture, state: 'proposed' }, request)).toBe('apply');
  });

  it('rejects a stale revision, a different digest, another task and a retired revision', () => {
    expect(evaluateGraphCas(revisionFixture, { ...request, baseRevision: 1 })).toBe(
      'stale_revision',
    );
    expect(evaluateGraphCas(revisionFixture, { ...request, baseRevision: 3 })).toBe(
      'stale_revision',
    );
    expect(evaluateGraphCas(revisionFixture, { ...request, expectedDigest: 'b'.repeat(64) })).toBe(
      'digest_mismatch',
    );
    expect(
      evaluateGraphCas(revisionFixture, {
        ...request,
        taskId: '22222222-2222-4222-8222-222222222222',
      }),
    ).toBe('stale_revision');
    for (const state of ['rejected', 'superseded'] as const)
      expect(evaluateGraphCas({ ...revisionFixture, state }, request)).toBe('not_live');
  });

  it('answers with a closed set so callers can branch exhaustively', () => {
    expect(CAS_OUTCOMES).toEqual(['apply', 'stale_revision', 'digest_mismatch', 'not_live']);
  });

  it('requires a client request id and a base revision on every mutation', () => {
    const good = { clientRequestId: crypto.randomUUID(), cas: request, taskVersion: 7 };
    expect(graphMutationSchema.safeParse(good).success).toBe(true);
    expect(graphMutationSchema.safeParse({ ...good, cas: undefined }).success).toBe(false);
    expect(graphMutationSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });
});

describe('UI projection', () => {
  it('accepts the fixture and rejects unknown fields on graph and node', () => {
    expect(graphProjectionSchema.safeParse(projectionFixture).success).toBe(true);
    expect(graphProjectionSchema.safeParse({ ...projectionFixture, owner: 'x' }).success).toBe(
      false,
    );
    expect(
      projectionNodeSchema.safeParse({ ...projectionNode(), brief: 'private text' }).success,
    ).toBe(false);
  });

  it('refuses a reason from another state and an approval wait with nothing named', () => {
    expect(
      projectionNodeSchema.safeParse(projectionNode({ reason: 'retry_backoff' })).success,
    ).toBe(false);
    expect(
      projectionNodeSchema.safeParse(projectionNode({ state: 'awaiting_approval' })).success,
    ).toBe(false);
    expect(
      projectionNodeSchema.safeParse(
        projectionNode({
          state: 'awaiting_approval',
          reason: 'publish_approval',
          approval: { id: 'a1', kind: 'publish', requestedAt: FIXTURE_NOW },
        }),
      ).success,
    ).toBe(true);
  });

  it('omits an inaccessible node entirely, without a count or a dangling edge', () => {
    const secret = projectionNode({ key: 'secret-part', title: 'Private salary review' });
    const shown = projectionNode({ key: 'part-2', dependsOn: ['secret-part', 'part-1'] });
    const open = projectionNode({ key: 'part-1' });
    const nodes = visibleNodes([
      { node: secret, accessible: false, resultAuthorized: true },
      { node: shown, accessible: true, resultAuthorized: false },
      { node: open, accessible: true, resultAuthorized: true },
    ]);
    const body = JSON.stringify(graphProjectionSchema.parse({ ...projectionFixture, nodes }));
    expect(nodes.map((n) => n.key)).toEqual(['part-2', 'part-1']);
    expect(body).not.toContain('secret-part');
    expect(body).not.toContain('Private salary review');
    expect(nodes[0].dependsOn).toEqual(['part-1']);
  });

  it('drops a result link the caller is not authorised to open', () => {
    const withResult = projectionNode({
      state: 'succeeded',
      result: { href: '/r/1', label: 'Findings' },
    });
    const hidden = visibleNodes([{ node: withResult, accessible: true, resultAuthorized: false }]);
    const shown = visibleNodes([{ node: withResult, accessible: true, resultAuthorized: true }]);
    expect(hidden.map((n) => n.result)).toEqual([null]);
    expect(shown.map((n) => n.result?.href)).toEqual(['/r/1']);
  });

  it('converges on the newest server revision whatever order updates arrive in', () => {
    const at = (serverRevision: number, taskVersion: number) => ({ serverRevision, taskVersion });
    const arrivals = [at(2, 5), at(1, 9), at(2, 7), at(3, 1), at(2, 6)];
    for (const order of [
      arrivals,
      [...arrivals].reverse(),
      [arrivals[3], ...arrivals.slice(0, 3), arrivals[4]],
    ]) {
      let held: ReturnType<typeof at> | undefined;
      for (const incoming of order) if (isNewerProjection(held, incoming)) held = incoming;
      expect(held).toEqual(at(3, 1));
    }
    expect(isNewerProjection(at(2, 7), at(2, 7))).toBe(false);
  });
});

describe('contract identity', () => {
  it('versions the contract and parses revision, cas, state and reason values', () => {
    expect(GRAPH_CONTRACT_VERSION).toBe('teamwork.graph.v1');
    expect(graphRevisionSchema.safeParse(revisionFixture).success).toBe(true);
    expect(graphRevisionSchema.safeParse({ ...revisionFixture, workspaceId: 'w' }).success).toBe(
      false,
    );
    expect(graphCasSchema.safeParse({ taskId: FIXTURE_TASK_ID, baseRevision: 0 }).success).toBe(
      false,
    );
    expect(nodeStateSchema.options).toEqual([...NODE_STATES]);
    expect(nodeReasonSchema.options).toEqual([...NODE_REASONS]);
  });
});
