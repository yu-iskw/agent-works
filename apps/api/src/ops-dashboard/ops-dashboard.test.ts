import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import { authorizeScope } from './access.js';
import { validateAlerts } from './alert-definition.js';
import { reconcileBillingSample } from './billing-harness.js';
import { parseBillingCsv, parseBillingJson } from './billing.js';
import { reconcileDashboard } from './reconcile.js';
import { NOW, WINDOW, dockerAvailable, exec, principal, seedLedger } from './seed.testkit.js';
import { createOpsDashboard } from './service.js';
import { OpsDenied } from './types.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';
import type { Sql } from 'postgres';

const fixture = (name: string) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed fixture directory
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const live = dockerAvailable();
let database: DisposablePostgres | undefined;
let sql: Sql;
const lines = () => Promise.resolve(parseBillingCsv(fixture('billing-sample.csv')));
const service = () => createOpsDashboard({ sql, now: () => new Date(NOW), billing: { lines } });

beforeAll(async () => {
  if (!live) return;
  database = await startDisposablePostgres();
  sql = openSql(database.url);
  const { workerReady } = await import('../worker/migration.js');
  const { admissionReady } = await import('../admission/migration.js');
  await workerReady(sql);
  await admissionReady(sql);
  await seedLedger(sql);
}, 90_000);
afterAll(async () => {
  if (!live) return;
  await sql.end({ timeout: 1 });
  await database?.stop();
});

describe('scope authorization', () => {
  test('defaults to own member scope and allows granted scopes', () => {
    expect(authorizeScope(principal())).toEqual({ kind: 'member', id: 'm1' });
    const lead = principal({ adminSegmentIds: ['s1'], ownedBotIds: ['b1'] });
    expect(authorizeScope(lead, { kind: 'segment', id: 's1' }).id).toBe('s1');
    expect(authorizeScope(lead, { kind: 'bot', id: 'b1' }).id).toBe('b1');
  });
  test.each([
    [{ kind: 'member', id: 'm2' }],
    [{ kind: 'segment', id: 's1' }],
    [{ kind: 'bot', id: 'b1' }],
    [{ kind: 'all', id: '' }],
    [{ kind: 'member', id: '' }],
  ] as const)('outsider forging %j is denied', (scope) => {
    expect(() => authorizeScope(principal(), scope)).toThrow(OpsDenied);
  });
  test('segment admin cannot reach another segment or all', () => {
    const lead = principal({ adminSegmentIds: ['s1'] });
    expect(() => authorizeScope(lead, { kind: 'segment', id: 's2' })).toThrow(OpsDenied);
    expect(() => authorizeScope(lead, { kind: 'all', id: '' })).toThrow(OpsDenied);
  });
  test('platform admin may read any scope', () => {
    expect(authorizeScope(principal({ platformAdmin: true }), { kind: 'all', id: '' }).kind).toBe(
      'all',
    );
  });
});

describe.skipIf(!live)('dashboard on a seeded ledger (real PostgreSQL)', () => {
  test('member sees exactly their own executions', async () => {
    const view = await service().view(principal(), undefined, WINDOW);
    expect(view.cost.estimated).toEqual({
      executions: 2,
      estimatedMicros: 1500,
      recordedMicros: 1400,
    });
    expect(view.cost.succeededExecutions).toBe(1);
    expect(view.cost.perSuccessfulTaskMicros).toBe(1400);
    expect(view.dueToClaim).toMatchObject({ samples: 2, p50Ms: 2000, p95Ms: 4000, maxMs: 4000 });
    expect(view.backlog).toMatchObject({ queued: 1, oldestQueuedMs: 3_540_000 });
    expect(view.outbox).toMatchObject({ pending: 1, published: 1, oldestPendingMs: 3_536_000 });
    expect(view.retries).toEqual({ executions: 2, attempts: 3, retries: 1, amplification: 1.5 });
    expect(view.quota.byState).toEqual({ succeeded: 1, failed: 1 });
    expect(view.quota.limits).toBeNull();
  });

  test('another member never sees m1 data, and m1 cannot ask for it', async () => {
    const m2 = await service().view(principal({ memberId: 'm2' }), undefined, WINDOW);
    expect(m2.cost.estimated.executions).toBe(1);
    expect(m2.cost.estimated.estimatedMicros).toBe(2000);
    expect(m2.cost.billed.micros).toBe(2000);
    await expect(
      service().view(principal(), { kind: 'member', id: 'm2' }, WINDOW),
    ).rejects.toBeInstanceOf(OpsDenied);
  });

  test('outsider with no ledger rows sees zeros, not other users', async () => {
    const view = await service().view(principal({ memberId: 'nobody' }), undefined, WINDOW);
    expect(view.cost.estimated.executions).toBe(0);
    expect(view.cost.billed.micros).toBe(0);
    expect(view.cost.unassigned.lines).toBe(0);
    expect(view.backlog.queued).toBe(0);
    expect(view.dueToClaim.samples).toBe(0);
  });

  test('segment admin sees the segment including team-labelled billing, but not unassigned', async () => {
    const lead = principal({ adminSegmentIds: ['s1', 's2'] });
    const s1 = await service().view(lead, { kind: 'segment', id: 's1' }, WINDOW);
    expect(s1.cost.estimated).toEqual({
      executions: 3,
      estimatedMicros: 3500,
      recordedMicros: 3400,
    });
    expect(s1.cost.perSuccessfulTaskMicros).toBe(1700);
    expect(s1.cost.billed).toEqual({ status: 'provided', lines: 2, micros: 3000 });
    expect(s1.cost.unassigned.lines).toBe(0);
    const s2 = await service().view(lead, { kind: 'segment', id: 's2' }, WINDOW);
    expect(s2.cost.billed.micros).toBe(300);
  });

  test('three cost categories stay separate and nothing unowned is dropped at all scope', async () => {
    const all = await service().view(
      principal({ platformAdmin: true }),
      { kind: 'all', id: '' },
      WINDOW,
    );
    expect(all.cost.estimated.estimatedMicros).toBe(4200);
    expect(all.cost.billed).toEqual({ status: 'provided', lines: 3, micros: 3300 });
    expect(all.cost.unassigned).toEqual({ lines: 2, micros: 75, noLabel: 1, unknownExecution: 1 });
    const export_ = parseBillingCsv(fixture('billing-sample.csv')).reduce(
      (n, l) => n + l.amountMicros,
      0,
    );
    expect(all.cost.billed.micros + all.cost.unassigned.micros).toBe(export_);
  });

  test('without a billing export billed is explicitly not provided', async () => {
    const bare = createOpsDashboard({ sql, now: () => new Date(NOW) });
    const view = await bare.view(principal(), undefined, WINDOW);
    expect(view.cost.billed).toEqual({ status: 'not_provided', lines: 0, micros: 0 });
  });

  test('owner-set limits are reported as configured, never invented', async () => {
    await sql`insert into admission_limits(scope_kind, scope_id, max_concurrent, max_cost_micros) values ('member','m1',3,9000)`;
    const view = await service().view(principal(), undefined, WINDOW);
    expect(view.quota.limits).toEqual({ maxConcurrent: 3, maxCostMicros: 9000 });
    await sql`delete from admission_limits`;
  });

  test('dashboard totals reconcile exactly to the ledger for every scope', async () => {
    const admin = principal({ platformAdmin: true });
    for (const scope of [
      { kind: 'all', id: '' },
      { kind: 'segment', id: 's1' },
      { kind: 'segment', id: 's2' },
      { kind: 'member', id: 'm1' },
      { kind: 'bot', id: 'b2' },
    ] as const) {
      const result = await service().reconcile(admin, scope, WINDOW);
      expect(result.reconciliation.ok).toBe(true);
      expect(result.reconciliation.checks.every((c) => c.delta === 0)).toBe(true);
      expect(result.reconciliation.ledgerAttribution.ratio).toBe(1);
      expect(result.reconciliation.ledgerAttribution.meetsProvisionalTarget).toBe(true);
    }
  });

  test('segment views sum to the all view', async () => {
    const admin = principal({ platformAdmin: true });
    const [a, s1, s2] = await Promise.all([
      service().view(admin, { kind: 'all', id: '' }, WINDOW),
      service().view(admin, { kind: 'segment', id: 's1' }, WINDOW),
      service().view(admin, { kind: 'segment', id: 's2' }, WINDOW),
    ]);
    expect(s1.cost.estimated.estimatedMicros + s2.cost.estimated.estimatedMicros).toBe(
      a.cost.estimated.estimatedMicros,
    );
    expect(s1.cost.billed.micros + s2.cost.billed.micros).toBe(a.cost.billed.micros);
  });

  test('reconciliation reports a nonzero delta when a dashboard total is wrong', async () => {
    const view = await service().view(
      principal({ platformAdmin: true }),
      { kind: 'all', id: '' },
      WINDOW,
    );
    const tampered = {
      ...view,
      cost: {
        ...view.cost,
        estimated: {
          ...view.cost.estimated,
          recordedMicros: view.cost.estimated.recordedMicros + 7,
        },
      },
    };
    const result = await reconcileDashboard(sql, tampered);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'recordedMicros')?.delta).toBe(7);
  });

  test('ledger attribution drops below target when a row has no owner', async () => {
    await sql`insert into admission_reservations(execution_id, member_id, bot_id, segment_id, window_key, state, estimated_cost_micros, cost_micros, created_at, expires_at)
      values ('orphan', '', '', '', 'w1', 'succeeded', 100000, 100000, '2026-11-03T10:30:00Z', '2026-11-03T10:30:00Z')`;
    const result = await service().reconcile(
      principal({ platformAdmin: true }),
      { kind: 'all', id: '' },
      WINDOW,
    );
    expect(result.reconciliation.ok).toBe(true);
    expect(result.reconciliation.ledgerAttribution.meetsProvisionalTarget).toBe(false);
    await sql`delete from admission_reservations where execution_id = 'orphan'`;
  });

  test('billing sample: CSV and JSON agree and attribution is computed', async () => {
    const csv = await reconcileBillingSample(sql, fixture('billing-sample.csv'), 'csv');
    const json = await reconcileBillingSample(sql, fixture('billing-sample.json'), 'json');
    expect(json).toEqual(csv);
    expect(csv).toMatchObject({
      lines: 5,
      totalMicros: 3375,
      unassignedMicros: 75,
      balanced: true,
    });
    expect(csv.unassignedLineIds).toEqual(['bl4', 'bl5']);
    expect(csv.attributionRatio).toBeCloseTo(3300 / 3375, 10);
    expect(csv.meetsProvisionalTarget).toBe(false);
    expect(csv.bySegment).toEqual({ s1: 3000, s2: 300 });
  });

  test('billing sample at or above 99% meets the provisional target', async () => {
    const text = `line_id,amount_micros,execution_id,segment_id,service\na,990,${exec(1)},,m\nb,10,,,m\n`;
    const report = await reconcileBillingSample(sql, text, 'csv');
    expect(report.attributionRatio).toBe(0.99);
    expect(report.meetsProvisionalTarget).toBe(true);
  });

  test('an empty billing export has no ratio rather than a fake 100%', async () => {
    const report = await reconcileBillingSample(sql, 'line_id,amount_micros\n', 'csv');
    expect(report.attributionRatio).toBeNull();
    expect(report.meetsProvisionalTarget).toBeNull();
  });
});

describe('billing export parsing', () => {
  test.each([
    ['duplicate line id', 'line_id,amount_micros\na,1\na,2\n'],
    ['negative amount', 'line_id,amount_micros\na,-1\n'],
    ['fractional amount', 'line_id,amount_micros\na,1.5\n'],
    ['missing column', 'line_id,execution_id\na,x\n'],
    ['short row', 'line_id,amount_micros\na\n'],
  ])('rejects %s', (_name, text) => {
    expect(() => parseBillingCsv(text)).toThrow();
  });
  test('rejects a JSON export that is not a list', () => {
    expect(() => parseBillingJson('{"rows": []}')).toThrow();
  });
});

describe('alert definitions', () => {
  const filled = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      alerts: [
        {
          id: 'outbox-lag',
          metric: 'outbox.oldestPendingMs',
          comparator: 'gt',
          threshold: 1,
          forSeconds: 60,
          severity: 'page',
          responder: { name: 'Test Responder', contact: 'oncall-test@example.invalid' },
          runbook: { url: 'docs/runbooks/outbox-lag.md' },
          ...overrides,
        },
      ],
    });

  test('the shipped proposal fails while responder, runbook and threshold are unset', () => {
    const result = validateAlerts(
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed proposal path
      readFileSync(
        new URL(
          '../../../../docs/plans/enterprise-production-v1/ops-02/alerts.proposed.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(result.ok).toBe(false);
    const problems = result.ok ? [] : result.problems.join('\n');
    expect(problems).toContain('responder.name');
    expect(problems).toContain('responder.contact');
    expect(problems).toContain('runbook.url');
    expect(problems).toContain('threshold');
  });
  test('a named responder with a runbook passes', () => {
    expect(validateAlerts(filled()).ok).toBe(true);
  });
  test.each([
    ['empty responder', { responder: { name: '', contact: 'x@example.invalid' } }],
    ['TBD responder', { responder: { name: 'TBD', contact: 'x@example.invalid' } }],
    ['unset runbook', { runbook: { url: 'unset' } }],
    ['non-link runbook', { runbook: { url: 'somewhere' } }],
    ['missing threshold', { threshold: null }],
  ])('fails on %s', (_name, overrides) => {
    expect(validateAlerts(filled(overrides)).ok).toBe(false);
  });
});
