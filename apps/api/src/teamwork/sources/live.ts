import { repositoryAllowed } from '@agent-works/domain/teamwork-policy';

import { call, json, keywords, score, text } from './http.js';
import { computeCalculations, monthlyQuery, periodsFor } from './metrics.js';
import { SourceError } from './port.js';

import type { SegmentSources } from '../config.js';
import type {
  Published,
  PublishRequest,
  SourceItem,
  SourcePort,
  SourceRequest,
  SourceResult,
  TokenSource,
} from './port.js';
import type { MetricsScope } from '@agent-works/domain/teamwork';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';
const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const GH = 'https://api.github.com';
const GH_ACCEPT = 'application/vnd.github+json';
const MAX_DOCS = 8;
const MAX_EXCERPT = 3500;
const MAX_BYTES_BILLED = 10 * 1024 * 1024;
const IDEMPOTENCY_PROPERTY = 'awIdem';

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  version?: string;
};

/** The date the document itself states (review or meeting date) beats the upload time. */
export function statedDate(body: string): string | null {
  const match = /(?:Last reviewed|Meeting date|Date|Dates):\s*(\d{4}-\d{2}-\d{2})/i.exec(body);
  return match === null ? null : `${match[1]}T00:00:00Z`;
}

const identifier = /^[A-Za-z0-9_-]{1,200}$/;

type Live = { readonly sources: SegmentSources; readonly load: typeof fetch };

function driveItem(kind: SourceRequest['kind'], file: DriveFile, body: string): SourceItem {
  const clean = body.replace(/^﻿/, '').replaceAll('\r\n', '\n').trim();
  const paragraphs = clean.split(/\n\s*\n/).length;
  return {
    sourceKind: kind,
    sourceId: file.id,
    title: file.name,
    location: `Full text, ${paragraphs} paragraph${paragraphs === 1 ? '' : 's'}`,
    excerpt: clean.slice(0, MAX_EXCERPT),
    url: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
    sourceRevision: file.version === undefined ? null : `drive version ${file.version}`,
    modifiedAt: statedDate(clean) ?? file.modifiedTime,
    provenance: `Google Drive, modified ${file.modifiedTime.slice(0, 10)}`,
  };
}

async function drive(
  { load }: Live,
  request: SourceRequest,
  folder: string | undefined,
): Promise<SourceResult> {
  if (folder === undefined || !identifier.test(folder))
    throw new SourceError('not_found', 'folder not configured');
  const token = await request.token('google');
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  const listing = await json<{ files?: DriveFile[] }>(
    load,
    `${DRIVE}/files?q=${q}&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,modifiedTime,webViewLink,version)`,
    { token },
  );
  const docs = (listing.files ?? []).filter(
    (file) => file.mimeType === 'application/vnd.google-apps.document',
  );
  if (docs.length === 0) throw new SourceError('empty', 'no documents in the folder');
  const words = keywords(request.query);
  const ranked = docs
    .map((file) => ({ file, rank: score(file.name, words) }))
    .sort((a, b) => b.rank - a.rank || a.file.name.localeCompare(b.file.name))
    .slice(0, MAX_DOCS);
  const items: SourceItem[] = [];
  for (const { file } of ranked) {
    let body: string;
    try {
      body = await text(load, `${DRIVE}/files/${file.id}/export?mimeType=text/plain`, {
        token,
        accept: 'text/plain',
      });
    } catch (error) {
      // One unreadable document is a gap, not a failure of the whole search.
      if (error instanceof SourceError && (error.code === 'denied' || error.code === 'not_found'))
        continue;
      throw error;
    }
    items.push(driveItem(request.kind, file, body));
  }
  if (items.length === 0) throw new SourceError('denied', 'no readable documents');
  return { items, metrics: null, repositoryRevision: null };
}

type Dataset = { readonly project: string; readonly dataset: string };

/** A dry run bounds every query before it is billed. */
function bigQueryRunner(load: typeof fetch, token: string, project: string) {
  return async (query: string, params: unknown[]): Promise<BqResult> => {
    const base = {
      query,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: params,
      maximumBytesBilled: String(MAX_BYTES_BILLED),
    };
    const dry = await json<{ totalBytesProcessed?: string }>(
      load,
      `${BQ}/projects/${project}/queries`,
      {
        method: 'POST',
        token,
        body: { ...base, dryRun: true },
      },
    );
    if (Number(dry.totalBytesProcessed ?? 0) > MAX_BYTES_BILLED)
      throw new SourceError('policy_denied', 'query too large');
    return json<BqResult>(load, `${BQ}/projects/${project}/queries`, {
      method: 'POST',
      token,
      body: { ...base, maxResults: 500, timeoutMs: 20_000 },
      timeoutMs: 30_000,
    });
  };
}

type MetricsRead = {
  readonly scope: MetricsScope;
  readonly periods: readonly string[];
  readonly rows: BqRow[];
  readonly defs: BqRow[];
  readonly freshness: string | null;
  readonly jobId: string | null;
};

function metricsResult({ project, dataset }: Dataset, read: MetricsRead): SourceResult {
  const { scope, periods, rows, defs, freshness, jobId } = read;
  const units = new Map(defs.map((row) => [row.metric ?? '', row.unit ?? '']));
  const calculations = computeCalculations(rows, scope, units);
  if (calculations.length === 0)
    throw new SourceError('empty', `no rows for both ${periods.join(' and ')}`);
  return {
    items: [],
    repositoryRevision: null,
    metrics: {
      calculations,
      freshness,
      observations: {
        sourceKind: 'bigquery_metrics',
        sourceId: `${project}.${dataset}.daily_kpis`,
        title: `${dataset}.daily_kpis monthly totals by ${scope.groupBy}`,
        location: `Named query monthly_by_${scope.groupBy}, periods ${periods.join(', ')}, ${rows.length} rows`,
        excerpt:
          rows
            .map(
              (row) =>
                `${row.metric} | ${row.grp} | ${row.period} | ${row.total} (data through ${row.last_day})`,
            )
            .join('\n') || 'No rows.',
        url: `https://console.cloud.google.com/bigquery?project=${project}&ws=!1m5!1m4!4m3!1s${project}!2s${dataset}!3sdaily_kpis`,
        sourceRevision: jobId === null ? null : `BigQuery job ${jobId}`,
        modifiedAt: freshness,
        provenance: `BigQuery ${project}.${dataset}, read-only named query, max ${MAX_BYTES_BILLED / 1024 / 1024} MB billed`,
      },
      definitions: {
        sourceKind: 'bigquery_metrics',
        sourceId: `${project}.${dataset}.metric_definitions`,
        title: `${dataset}.metric_definitions`,
        location: `All rows (${defs.length})`,
        excerpt:
          defs
            .map(
              (row) =>
                `${row.metric}: ${row.definition} Unit: ${row.unit}. Owner: ${row.owner}. Updated ${row.updated_at}.`,
            )
            .join('\n') || 'No rows.',
        url: null,
        sourceRevision: null,
        modifiedAt:
          defs
            .map((row) => row.updated_at ?? '')
            .sort()
            .at(-1) || null,
        provenance: `BigQuery ${project}.${dataset}, read-only`,
      },
    },
  };
}

async function bigquery({ sources, load }: Live, request: SourceRequest): Promise<SourceResult> {
  const { bigqueryProject: project, bigqueryDataset: dataset } = sources;
  if (
    project === undefined ||
    dataset === undefined ||
    !identifier.test(project) ||
    !identifier.test(dataset)
  )
    throw new SourceError('not_found', 'dataset not configured');
  if (request.metrics === null)
    throw new SourceError('invalid_scope', 'comparison periods are required');
  const token = await request.token('google');
  const periods = periodsFor(request.metrics);
  const runQuery = bigQueryRunner(load, token, project);
  const observations = await runQuery(monthlyQuery(project, dataset, request.metrics.groupBy), [
    {
      name: 'periods',
      parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
      parameterValue: { arrayValues: periods.map((value) => ({ value })) },
    },
  ]);
  const definitions = await runQuery(
    `select metric, definition, unit, owner, cast(updated_at as string) as updated_at from \`${project}.${dataset}.metric_definitions\` order by metric`,
    [],
  );
  const table = await json<{ lastModifiedTime?: string; numRows?: string }>(
    load,
    `${BQ}/projects/${project}/datasets/${dataset}/tables/daily_kpis`,
    { token },
  );
  const freshness =
    table.lastModifiedTime === undefined
      ? null
      : new Date(Number(table.lastModifiedTime)).toISOString();
  return metricsResult(
    { project, dataset },
    {
      scope: request.metrics,
      periods,
      rows: rowsOf(observations),
      defs: rowsOf(definitions),
      freshness,
      jobId: observations.jobReference?.jobId ?? null,
    },
  );
}

type PinnedRepo = {
  readonly repository: string;
  readonly token: string;
  readonly sha: string;
  readonly committed: string | null;
};

async function githubIssue(
  { load }: Live,
  request: SourceRequest,
  { repository, token, sha }: PinnedRepo,
): Promise<SourceResult> {
  if (request.issueNumber === null)
    throw new SourceError('invalid_scope', 'issue number is required');
  const issue = await json<{
    title: string;
    body: string | null;
    html_url: string;
    updated_at: string;
    number: number;
    labels: { name: string }[];
    pull_request?: unknown;
  }>(load, `${GH}/repos/${repository}/issues/${request.issueNumber}`, { token, accept: GH_ACCEPT });
  if (issue.pull_request !== undefined)
    throw new SourceError('invalid_scope', 'that number is a pull request');
  return {
    repositoryRevision: sha,
    metrics: null,
    items: [
      {
        sourceKind: 'github_issue',
        sourceId: `${repository}#${issue.number}`,
        title: `#${issue.number} ${issue.title}`,
        location: `Issue body; labels: ${issue.labels.map((label) => label.name).join(', ') || 'none'}`,
        excerpt: `${issue.title}\n\n${issue.body ?? ''}`.slice(0, MAX_EXCERPT),
        url: issue.html_url,
        sourceRevision: `updated ${issue.updated_at}`,
        modifiedAt: issue.updated_at,
        provenance: `GitHub issue in ${repository}`,
      },
    ],
  };
}

async function githubCode(
  { load }: Live,
  request: SourceRequest,
  { repository, token, sha, committed }: PinnedRepo,
): Promise<SourceResult> {
  const tree = await json<{ tree: { path: string; type: string; size?: number }[] }>(
    load,
    `${GH}/repos/${repository}/git/trees/${sha}?recursive=1`,
    { token, accept: GH_ACCEPT },
  );
  const words = keywords(request.query);
  const candidates = tree.tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        /^(apps|packages)\/.+\.(ts|tsx)$/.test(entry.path) &&
        !/\.test\.tsx?$/.test(entry.path) &&
        (entry.size ?? 0) < 60_000,
    )
    .map((entry) => ({
      path: entry.path,
      rank: score(entry.path.replaceAll(/[/_.-]/g, ' '), words),
    }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
    .slice(0, 6);
  const items: SourceItem[] = [];
  for (const candidate of candidates) {
    const body = await text(
      load,
      `${GH}/repos/${repository}/contents/${candidate.path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`,
      {
        token,
        accept: 'application/vnd.github.raw+json',
      },
    );
    const window = bestWindow(body, words);
    if (window === undefined) continue;
    items.push({
      sourceKind: 'github_code',
      sourceId: `${repository}:${candidate.path}`,
      title: candidate.path,
      location: `Lines ${window.start}-${window.end} at ${sha.slice(0, 12)}`,
      excerpt: window.text,
      url: `https://github.com/${repository}/blob/${sha}/${candidate.path}#L${window.start}-L${window.end}`,
      sourceRevision: sha,
      modifiedAt: committed,
      provenance: `GitHub ${repository} at pinned commit ${sha.slice(0, 12)}`,
    });
    if (items.length >= 4) break;
  }
  if (items.length === 0) throw new SourceError('empty', 'no relevant files');
  return { items, metrics: null, repositoryRevision: sha };
}

async function github(live: Live, request: SourceRequest): Promise<SourceResult> {
  const repository = request.repository;
  if (repository === null) throw new SourceError('invalid_scope', 'repository is required');
  if (!repositoryAllowed(repository, live.sources.githubRepositories))
    throw new SourceError('policy_denied', repository);
  const token = await request.token('github');
  const commit = await json<{ sha: string; commit: { committer?: { date?: string } } }>(
    live.load,
    `${GH}/repos/${repository}/commits/${encodeURIComponent(live.sources.githubPinnedRef ?? 'HEAD')}`,
    { token, accept: GH_ACCEPT },
  );
  const pinned: PinnedRepo = {
    repository,
    token,
    sha: commit.sha,
    committed: commit.commit.committer?.date ?? null,
  };
  return request.kind === 'github_issue'
    ? githubIssue(live, request, pinned)
    : githubCode(live, request, pinned);
}

async function findPublished(
  { load }: Live,
  token: TokenSource,
  idempotencyKey: string,
): Promise<Published | undefined> {
  const access = await token('google');
  const q = encodeURIComponent(
    `appProperties has { key='${IDEMPOTENCY_PROPERTY}' and value='${idempotencyKey}' } and trashed = false`,
  );
  const found = await json<{
    files?: { id: string; webViewLink?: string; createdTime?: string }[];
  }>(load, `${DRIVE}/files?q=${q}&fields=files(id,webViewLink,createdTime)&pageSize=5`, {
    token: access,
  });
  const file = found.files?.at(0);
  if (file === undefined) return undefined;
  const document = await json<{ body?: { content?: { endIndex?: number }[] } }>(
    load,
    `${DOCS}/documents/${file.id}?fields=body.content.endIndex`,
    { token: access },
  );
  const end = document.body?.content?.at(-1)?.endIndex ?? 1;
  // A document that exists but has no body text was created and not filled; publish fills it.
  if (end <= 2) return { documentId: file.id, url: '', confirmedAt: '' };
  return {
    documentId: file.id,
    url: file.webViewLink ?? `https://docs.google.com/document/d/${file.id}/edit`,
    confirmedAt: file.createdTime ?? new Date().toISOString(),
  };
}

async function publish(live: Live, request: PublishRequest): Promise<Published> {
  if (!/^[\w:.-]{1,100}$/.test(request.idempotencyKey))
    throw new SourceError('invalid_scope', 'bad key');
  const existing = await findPublished(live, request.token, request.idempotencyKey);
  if (existing !== undefined && existing.url !== '') return existing;
  const access = await request.token('google');
  const documentId =
    existing?.documentId ??
    (
      await json<{ id: string }>(live.load, `${DRIVE}/files?fields=id`, {
        method: 'POST',
        token: access,
        body: {
          name: request.title,
          mimeType: 'application/vnd.google-apps.document',
          appProperties: { [IDEMPOTENCY_PROPERTY]: request.idempotencyKey },
        },
      })
    ).id;
  await call(live.load, `${DOCS}/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    token: access,
    body: { requests: [{ insertText: { location: { index: 1 }, text: request.markdown } }] },
  });
  const confirmed = await findPublished(live, request.token, request.idempotencyKey);
  if (confirmed === undefined || confirmed.url === '')
    throw new SourceError('unavailable', 'not confirmed');
  return confirmed;
}

export function createLiveSources(sources: SegmentSources, load: typeof fetch = fetch): SourcePort {
  const live: Live = { sources, load };
  return {
    mode: 'live',
    async read(request) {
      switch (request.kind) {
        case 'drive_research':
          return drive(live, request, sources.driveResearchFolder);
        case 'drive_context':
          return drive(live, request, sources.driveContextFolder);
        case 'bigquery_metrics':
          return bigquery(live, request);
        case 'github_issue':
        case 'github_code':
          return github(live, request);
      }
    },
    findPublished: (token, idempotencyKey) => findPublished(live, token, idempotencyKey),
    publish: (request) => publish(live, request),
  };
}

type BqResult = {
  schema?: { fields?: { name: string }[] };
  rows?: { f: { v: string | null }[] }[];
  jobReference?: { jobId?: string };
};

export type BqRow = Record<string, string | undefined>;

function rowsOf(result: BqResult): BqRow[] {
  const names = result.schema?.fields?.map((field) => field.name) ?? [];
  return (result.rows ?? []).map((row) =>
    Object.fromEntries(names.map((name, index) => [name, row.f.at(index)?.v ?? undefined])),
  );
}

/** The 40-line window with the most keyword hits, rendered with line numbers. */
function bestWindow(
  body: string,
  words: readonly string[],
): { start: number; end: number; text: string } | undefined {
  const lines = body.split('\n');
  const size = 40;
  let best = { start: 0, hits: 0 };
  for (let start = 0; start < lines.length; start += 10) {
    const hits = score(lines.slice(start, start + size).join('\n'), words);
    if (hits > best.hits) best = { start, hits };
  }
  if (best.hits === 0) return undefined;
  const slice = lines.slice(best.start, best.start + size);
  return {
    start: best.start + 1,
    end: best.start + slice.length,
    text: slice
      .map((line, index) => `${best.start + index + 1}: ${line}`)
      .join('\n')
      .slice(0, MAX_EXCERPT),
  };
}
