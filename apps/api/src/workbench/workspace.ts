import { createHash } from 'node:crypto';

import { fixtureCorpus } from './fixture-corpus.js';

import type { FixtureDoc } from './fixture-corpus.js';
import type postgres from 'postgres';

export type DriveHit = {
  readonly sourceId: string;
  readonly title: string;
  readonly excerpt: string;
  readonly url: string | null;
  readonly modifiedAt: string;
};

type CreatedDoc = { readonly docId: string; readonly url: string };

type StoredDoc = {
  readonly docId: string;
  readonly title: string;
  readonly body: unknown;
  readonly createdAt: string;
};

export type WorkspaceErrorCode = 'drive_denied' | 'docs_failed' | 'docs_timeout';

export class WorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode) {
    super(code);
    this.name = 'WorkspaceError';
  }
}

/** Test-only fault switches, honoured only when WORKSPACE_FIXTURE_FAULTS=1. */
const FIXTURE_FAULTS = ['drive-denied', 'empty', 'docs-fail', 'docs-timeout'] as const;
export type FixtureFault = (typeof FIXTURE_FAULTS)[number];

export function faultsIn(objective: string, enabled: boolean): ReadonlySet<FixtureFault> {
  if (!enabled) return new Set();
  return new Set(FIXTURE_FAULTS.filter((fault) => objective.includes(`[fixture:${fault}]`)));
}

export interface WorkspacePort {
  readonly simulated: true;
  search(
    ownerSub: string,
    objective: string,
    faults: ReadonlySet<FixtureFault>,
  ): Promise<readonly DriveHit[]>;
  readSource(ownerSub: string, sourceId: string): FixtureDoc | undefined;
  createDoc(
    ownerSub: string,
    input: { readonly idempotencyKey: string; readonly title: string; readonly body: unknown },
    faults: ReadonlySet<FixtureFault>,
  ): Promise<CreatedDoc>;
  findDoc(idempotencyKey: string): Promise<CreatedDoc | undefined>;
  readDoc(ownerSub: string, docId: string): Promise<StoredDoc | undefined>;
}

const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const maxHits = 8;
const excerptLength = 600;

export function createFixtureWorkspace(sql: postgres.Sql): WorkspacePort {
  return {
    simulated: true,
    search(ownerSub, objective, faults) {
      if (faults.has('drive-denied')) return Promise.reject(new WorkspaceError('drive_denied'));
      if (faults.has('empty')) return Promise.resolve([]);
      return Promise.resolve(searchCorpus(ownerSub, objective));
    },
    readSource(ownerSub, sourceId) {
      return fixtureCorpus.find((doc) => doc.id === sourceId && doc.readers.includes(ownerSub));
    },
    async createDoc(ownerSub, input, faults) {
      if (faults.has('docs-fail')) throw new WorkspaceError('docs_failed');
      const docId = `fxdoc-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`;
      await sql`
        insert into wb_fixture_docs (idempotency_key, doc_id, owner_sub, title, body, created_at)
        values (${input.idempotencyKey}, ${docId}, ${ownerSub}, ${input.title},
                ${sql.json(input.body as postgres.JSONValue)}, now())
        on conflict (idempotency_key) do nothing
      `;
      // The write landed but the caller never hears back, as with a lost response.
      if (faults.has('docs-timeout')) throw new WorkspaceError('docs_timeout');
      const found = await this.findDoc(input.idempotencyKey);
      if (found === undefined) throw new WorkspaceError('docs_failed');
      return found;
    },
    async findDoc(idempotencyKey) {
      const rows = await sql<{ doc_id: string }[]>`
        select doc_id from wb_fixture_docs where idempotency_key = ${idempotencyKey}
      `;
      const docId = rows.at(0)?.doc_id;
      return docId === undefined ? undefined : { docId, url: `/fixtures/docs/${docId}` };
    },
    async readDoc(ownerSub, docId) {
      const rows = await sql<{ doc_id: string; title: string; body: unknown; created_at: Date }[]>`
        select doc_id, title, body, created_at from wb_fixture_docs
        where doc_id = ${docId} and owner_sub = ${ownerSub}
      `;
      const row = rows.at(0);
      return row === undefined
        ? undefined
        : {
            docId: row.doc_id,
            title: row.title,
            body: row.body,
            createdAt: row.created_at.toISOString(),
          };
    },
  };
}

/** "may" is also a verb, so May only counts when written as a proper noun. */
function mentionsMonth(objective: string, name: string): boolean {
  const title = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const words = objective.split(/[^A-Za-z]+/);
  return name === 'may' ? words.includes(title) : words.some((word) => word.toLowerCase() === name);
}

export function searchCorpus(ownerSub: string, objective: string): readonly DriveHit[] {
  const lowered = objective.toLowerCase();
  const month = months.findIndex((name) => mentionsMonth(objective, name));
  const wantsIncidents = /incident|outage|postmortem|post-mortem/.test(lowered);
  return fixtureCorpus
    .filter((doc) => doc.readers.includes(ownerSub))
    .filter((doc) => month < 0 || new Date(doc.modifiedAt).getUTCMonth() === month)
    .filter((doc) => !wantsIncidents || doc.kind === 'incident_report')
    .slice(0, maxHits)
    .map((doc) => ({
      sourceId: doc.id,
      title: doc.title,
      excerpt: doc.body.slice(0, excerptLength),
      url: doc.url,
      modifiedAt: doc.modifiedAt,
    }));
}
