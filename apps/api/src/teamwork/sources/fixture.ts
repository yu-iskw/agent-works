import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { keywords, score } from './http.js';
import { statedDate } from './live.js';
import { computeCalculations, periodsFor } from './metrics.js';
import { SourceError } from './port.js';

import type { BqRow } from './live.js';
import type {
  Published,
  PublishRequest,
  SourceItem,
  SourcePort,
  SourceRequest,
  SourceResult,
} from './port.js';
import type postgres from 'postgres';

/**
 * Labelled fixture sources for deterministic failure-path tests. They read the seed files in
 * `fixtures/m1` and the built checkout, never a live service, and every item says so. A run in
 * this mode can never satisfy a live acceptance gate.
 */
type FixtureOptions = {
  readonly root: string;
  readonly segment: string;
  readonly sql: postgres.Sql;
  readonly faults: boolean;
};

const FAULT = /\[fault:([a-z-]+)\]/g;

function faultsIn(text: string, enabled: boolean): ReadonlySet<string> {
  if (!enabled) return new Set();
  return new Set([...text.matchAll(FAULT)].map(([, fault = '']) => fault));
}

function files(dir: string): readonly string[] {
  try {
    // Fixture directory inside the build output, never request controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
}

function read(path: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readFileSync(path, 'utf8');
}

export function createFixtureSources(options: FixtureOptions): SourcePort {
  const base = join(options.root, 'fixtures/m1');
  const label = 'FIXTURE (local seed file, not a live service)';

  function drive(request: SourceRequest, folder: 'research' | 'context'): SourceResult {
    const dir = join(base, 'drive', options.segment, folder);
    const words = keywords(request.query);
    const items: SourceItem[] = files(dir)
      .map((name) => ({ name, body: read(join(dir, name)) }))
      .sort((a, b) => score(b.body, words) - score(a.body, words) || a.name.localeCompare(b.name))
      .map(({ name, body }) => ({
        sourceKind: request.kind,
        sourceId: `fixture-${options.segment}-${name.replace(/\.md$/, '')}`,
        title: name.replace(/\.md$/, ''),
        location: `Full text, ${body.trim().split(/\n\s*\n/).length} paragraphs`,
        excerpt: body.trim(),
        url: null,
        sourceRevision: createHash('sha256').update(body).digest('hex').slice(0, 12),
        modifiedAt: statedDate(body),
        provenance: label,
      }));
    if (items.length === 0) throw new SourceError('empty');
    return { items, metrics: null, repositoryRevision: null };
  }

  function metrics(request: SourceRequest): SourceResult {
    if (request.metrics === null) throw new SourceError('invalid_scope');
    const csv = read(join(base, 'bigquery', options.segment, 'daily_kpis.csv'))
      .trim()
      .split('\n')
      .slice(1);
    const periods = periodsFor(request.metrics);
    const totals = new Map<string, { total: number; last: string }>();
    for (const line of csv) {
      const cells = line.split(',');
      const period = (cells[0] ?? '').slice(0, 7);
      if (!periods.includes(period)) continue;
      const grp = request.metrics.groupBy === 'region' ? cells[1] : cells[2];
      const key = `${cells[3]}|${grp}|${period}`;
      const prior = totals.get(key) ?? { total: 0, last: '' };
      totals.set(key, {
        total: prior.total + Number(cells[4]),
        last: (cells[0] ?? '') > prior.last ? (cells[0] ?? '') : prior.last,
      });
    }
    const rows: BqRow[] = [...totals].map(([key, value]) => {
      const [metric, grp, period] = key.split('|');
      return {
        metric,
        grp,
        period,
        total: String(Number(value.total.toFixed(2))),
        last_day: value.last,
      };
    });
    const defs = read(join(base, 'bigquery', options.segment, 'metric_definitions.csv'))
      .trim()
      .split('\n')
      .slice(1);
    const units = new Map(
      defs.map((line) => [line.split(',')[0] ?? '', line.split(',').at(-3) ?? '']),
    );
    const calculations = computeCalculations(rows, request.metrics, units);
    if (calculations.length === 0) throw new SourceError('empty');
    return {
      items: [],
      repositoryRevision: null,
      metrics: {
        calculations,
        freshness: null,
        observations: {
          sourceKind: 'bigquery_metrics',
          sourceId: `fixture-${options.segment}-daily_kpis`,
          title: `daily_kpis monthly totals by ${request.metrics.groupBy}`,
          location: `Fixture CSV, periods ${periods.join(', ')}, ${rows.length} rows`,
          excerpt: rows
            .map((row) => `${row.metric} | ${row.grp} | ${row.period} | ${row.total}`)
            .join('\n'),
          url: null,
          sourceRevision: null,
          modifiedAt: null,
          provenance: label,
        },
        definitions: {
          sourceKind: 'bigquery_metrics',
          sourceId: `fixture-${options.segment}-metric_definitions`,
          title: 'metric_definitions',
          location: `Fixture CSV, ${defs.length} rows`,
          excerpt: defs.join('\n'),
          url: null,
          sourceRevision: null,
          modifiedAt: '2026-09-30T00:00:00Z',
          provenance: label,
        },
      },
    };
  }

  function github(request: SourceRequest): SourceResult {
    const words = keywords(request.query);
    if (request.kind === 'github_issue') {
      const manifest = JSON.parse(read(join(base, 'expected/engineering.json'))) as {
        segments: Record<string, { issueTitle: string }>;
      };
      const title =
        new Map(Object.entries(manifest.segments)).get(options.segment)?.issueTitle ??
        'Fixture issue';
      return {
        repositoryRevision: 'fixture',
        metrics: null,
        items: [
          {
            sourceKind: 'github_issue',
            sourceId: `fixture-issue-${options.segment}`,
            title,
            location: 'Issue title (fixture)',
            excerpt: title,
            url: null,
            sourceRevision: null,
            modifiedAt: null,
            provenance: label,
          },
        ],
      };
    }
    const candidates = [
      'apps/web/app/workbench/handler.ts',
      'apps/web/app/workbench/task-views.tsx',
      'apps/api/src/workbench/routes.ts',
      'apps/api/src/http.ts',
    ]
      .map((path) => ({ path, body: read(join(options.root, path)) }))
      .sort((a, b) => score(b.body, words) - score(a.body, words))
      .slice(0, 2);
    return {
      repositoryRevision: 'fixture',
      metrics: null,
      items: candidates.map(({ path, body }) => ({
        sourceKind: 'github_code' as const,
        sourceId: `fixture:${path}`,
        title: path,
        location: 'Lines 1-40 (fixture checkout)',
        excerpt: body
          .split('\n')
          .slice(0, 40)
          .map((line, index) => `${index + 1}: ${line}`)
          .join('\n'),
        url: null,
        sourceRevision: 'fixture',
        modifiedAt: null,
        provenance: label,
      })),
    };
  }

  async function findPublished(_token: unknown, key: string): Promise<Published | undefined> {
    const rows = await options.sql<{ doc_id: string; created_at: Date }[]>`
      select doc_id, created_at from wb_fixture_docs where idempotency_key = ${key}
    `;
    const row = rows.at(0);
    return row === undefined
      ? undefined
      : {
          documentId: row.doc_id,
          url: `/fixtures/docs/${row.doc_id}`,
          confirmedAt: row.created_at.toISOString(),
        };
  }

  return {
    mode: 'fixture',
    read(request) {
      const faults = faultsIn(request.query, options.faults);
      if (faults.has('denied')) return Promise.reject(new SourceError('denied'));
      if (faults.has('empty')) return Promise.reject(new SourceError('empty'));
      if (faults.has('unavailable')) return Promise.reject(new SourceError('unavailable'));
      switch (request.kind) {
        case 'drive_research':
          return Promise.resolve(drive(request, 'research'));
        case 'drive_context':
          return Promise.resolve(drive(request, 'context'));
        case 'bigquery_metrics':
          return Promise.resolve(metrics(request));
        case 'github_issue':
        case 'github_code':
          return Promise.resolve(github(request));
      }
    },
    findPublished,
    async publish(request: PublishRequest) {
      const existing = await findPublished(undefined, request.idempotencyKey);
      if (existing !== undefined) return existing;
      const faults = faultsIn(request.markdown, options.faults);
      if (faults.has('publish-fail')) throw new SourceError('denied');
      const docId = `fxdoc-${createHash('sha256').update(request.idempotencyKey).digest('hex').slice(0, 16)}`;
      await options.sql`
        insert into wb_fixture_docs (idempotency_key, doc_id, owner_sub, title, body, created_at)
        values (${request.idempotencyKey}, ${docId}, ${options.segment}, ${request.title},
          ${options.sql.json({ markdown: request.markdown })}, now())
        on conflict (idempotency_key) do nothing
      `;
      // Simulates a write that landed but whose confirmation was lost.
      if (faults.has('publish-uncertain')) throw new SourceError('unavailable', 'no confirmation');
      const created = await findPublished(undefined, request.idempotencyKey);
      if (created === undefined) throw new SourceError('unavailable');
      return created;
    },
  };
}
