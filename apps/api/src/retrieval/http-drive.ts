import { createHash } from 'node:crypto';

import { IAP_ASSERTION_HEADER, sourceCitationSchema } from '@agent-works/domain';
import * as z from 'zod';

import { RetrievalError } from './drive-port.js';
import {
  DRIVE_REGION,
  DRIVE_SOURCE,
  NEVER_OBSERVED,
  PUBLIC_FOLDER,
  askPolicy,
  boundTo,
  contextFor,
  rankByOverlap,
  readable,
} from './search.js';

import type { Drive, SourceDocument } from './drive-port.js';
import type { GroupSnapshot, RetrievalPolicy } from './search.js';
import type { Caller } from '../auth/iap.js';
import type { IndexedDocument, SearchPort } from '../ports/search-port.js';
import type { SearchContext } from '@agent-works/domain';

type FaultKind =
  | 'drive unreachable'
  | 'drive timeout'
  | 'drive status'
  | 'drive body'
  | 'drive shape'
  | 'directory unreachable'
  | 'directory timeout'
  | 'directory status'
  | 'directory body'
  | 'directory shape'
  | 'directory identity';

export class DriveFault extends RetrievalError {
  constructor(readonly kind: FaultKind) {
    super(kind);
    this.name = 'DriveFault';
  }
}

type DriveReaderOptions = {
  readonly driveUrl: string;
  readonly directoryUrl?: string;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly timeoutMs: number;
};

const documentsSchema = z.array(
  z.object({
    id: z.string().min(1),
    folder: z.string().min(1),
    title: z.string().min(1),
    text: z.string(),
    webViewLink: sourceCitationSchema.shape.sourceUri,
  }),
);

const snapshotSchema = z.object({
  sub: z.string().min(1),
  groups: z.array(z.string().min(1)),
  observedAt: z.iso.datetime(),
});

const excerptLength = 160;

export type HttpDriveOptions = {
  readonly baseUrl: string;
  readonly workerToken?: string;
  readonly directoryUrl?: string;
  readonly policy?: RetrievalPolicy;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
};

export type SearchScope = {
  readonly context: SearchContext;
  readonly port: SearchPort;
};

export interface HttpDrive extends Drive {
  open(caller: Caller): Promise<SearchScope>;
  openWorker(subject: string): Promise<SearchScope>;
}

const defaultTimeoutMs = 5_000;

export function createHttpDrive(options: HttpDriveOptions): HttpDrive {
  const policy = options.policy ?? askPolicy;
  const reader: DriveReaderOptions = {
    driveUrl: options.baseUrl,
    directoryUrl: options.directoryUrl,
    fetch: options.fetch ?? fetch,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
  };
  const read = (caller: Caller) =>
    Promise.all([readDocuments(reader, caller), readSnapshot(reader, caller)]);
  return {
    async retrieve(caller, question) {
      const [documents, snapshot] = await read(caller);
      const context = contextFor(caller, snapshot, policy);
      return rankByOverlap(question, readable(context, documents), context.resultCountLimit).map(
        toSource,
      );
    },
    async openWorker(subject) {
      if (!options.workerToken) throw new DriveFault('drive status');
      const caller = { sub: subject, assertion: '' } as Caller;
      const documents = await readDocuments(reader, caller, {
        authorization: `Bearer ${options.workerToken}`,
        'x-worker-subject': subject,
      });
      const snapshot = await readSnapshot(reader, caller);
      return {
        context: contextFor(caller, snapshot, policy),
        port: boundTo(subject, {
          search: (context, question) =>
            Promise.resolve(
              rankByOverlap(question, readable(context, documents), context.resultCountLimit).map(
                (document) => ({ ...document.citation, text: document.text }),
              ),
            ),
        }),
      };
    },
    async open(caller) {
      const [documents, snapshot] = await read(caller);
      return {
        context: contextFor(caller, snapshot, policy),
        port: boundTo(caller.sub, {
          search: (context, question) =>
            Promise.resolve(
              rankByOverlap(question, readable(context, documents), context.resultCountLimit).map(
                (document) => ({ ...document.citation, text: document.text }),
              ),
            ),
        }),
      };
    },
  };
}

function toSource(document: IndexedDocument): SourceDocument {
  return {
    id: document.citation.sourceObjectId,
    title: document.citation.title,
    text: document.text,
    uri: document.citation.sourceUri,
  };
}

type Peer = 'drive' | 'directory';

async function getJson(
  options: DriveReaderOptions,
  peer: Peer,
  url: URL,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new DriveFault(isTimeout(error) ? `${peer} timeout` : `${peer} unreachable`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { status: response.status, body: undefined };
  }
  try {
    return { status: response.status, body: (await response.json()) as unknown };
  } catch (error) {
    throw new DriveFault(isTimeout(error) ? `${peer} timeout` : `${peer} body`);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

async function readDocuments(
  options: DriveReaderOptions,
  caller: Caller,
  headers: Record<string, string> = { [IAP_ASSERTION_HEADER]: caller.assertion },
): Promise<readonly IndexedDocument[]> {
  const url = new URL('/documents', options.driveUrl);
  const reply = await getJson(options, 'drive', url, headers);
  if (reply.status !== 200) throw new DriveFault('drive status');
  const parsed = documentsSchema.safeParse(reply.body);
  if (!parsed.success) throw new DriveFault('drive shape');
  const retrievedAt = options.now().toISOString();
  return parsed.data.map((document) => ({
    citation: {
      sourceObjectId: document.id,
      title: document.title,
      sourceUri: document.webViewLink,
      etag: createHash('sha256').update(document.text).digest('hex'),
      retrievedAt,
      accessDecisionId: `drive:${caller.sub}:${document.id}`,
      excerpt: document.text.slice(0, excerptLength) || document.title,
    },
    groups: [document.folder],
    classification: document.folder === PUBLIC_FOLDER ? 'PUBLIC' : 'INTERNAL',
    source: DRIVE_SOURCE,
    region: DRIVE_REGION,
    text: document.text,
  }));
}

async function readSnapshot(options: DriveReaderOptions, caller: Caller): Promise<GroupSnapshot> {
  if (options.directoryUrl === undefined) return { groups: [], observedAt: NEVER_OBSERVED };
  const url = new URL(`/snapshots/${encodeURIComponent(caller.sub)}`, options.directoryUrl);
  const reply = await getJson(options, 'directory', url, {});
  if (reply.status === 404) return { groups: [], observedAt: options.now().toISOString() };
  if (reply.status !== 200) throw new DriveFault('directory status');
  const parsed = snapshotSchema.safeParse(reply.body);
  if (!parsed.success) throw new DriveFault('directory shape');
  if (parsed.data.sub !== caller.sub) throw new DriveFault('directory identity');
  return { groups: parsed.data.groups, observedAt: parsed.data.observedAt };
}
