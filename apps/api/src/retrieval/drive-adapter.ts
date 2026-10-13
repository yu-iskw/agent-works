import { createHash } from 'node:crypto';

import { CLASSIFICATIONS, searchContextSchema } from '@agent-works/domain';
import * as z from 'zod';

import { RetrievalError } from './drive-port.js';

import type { Caller } from '../auth/iap.js';
import type { SearchHit, SearchPort } from '../ports/search-port.js';
import type { Classification, SearchContext } from '@agent-works/domain';

const readScope = 'https://www.googleapis.com/auth/drive.readonly';
const origin = 'https://www.googleapis.com';
const fileFields = 'id,name,mimeType,version,trashed,capabilities(canDownload)';
const policyDenied = 'policy-denied';
const label = z.string().trim().min(1);
const credentialSchema = z.strictObject({
  kind: z.literal('user-delegated'),
  callerSubject: label,
  googleSubject: label,
  accessToken: z.string().regex(/^[A-Za-z0-9._~+/-]+={0,2}$/),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
  // These must come from the trusted OAuth grant store, never request parameters.
  identityVerified: z.literal(true),
  domainWideDelegation: z.literal(false),
});
const listingSchema = z.object({
  files: z.array(z.object({ id: label.regex(/^[A-Za-z0-9_-]+$/) })),
  nextPageToken: label.optional(),
  incompleteSearch: z.boolean().optional(),
});
const metadataSchema = z.object({
  id: label.regex(/^[A-Za-z0-9_-]+$/),
  name: label,
  mimeType: label,
  version: label.regex(/^\d+$/),
  trashed: z.boolean(),
  capabilities: z.object({ canDownload: z.boolean() }),
});

export type DelegatedCredential = z.infer<typeof credentialSchema>;
type DriveFileMetadata = z.infer<typeof metadataSchema>;
type DriveDocumentPolicy = {
  readonly enterpriseId: string;
  readonly classification: Classification;
  readonly region: string;
};
type DriveAccessEvent = {
  readonly decision:
    'allowed' | 'permission-denied' | 'not-found-or-denied' | 'policy-denied' | 'changed';
  readonly sourceObjectId: string;
};
export type DriveAdapterOptions = {
  readonly caller: Caller;
  /** Trusted integration boundary: validates grant origin and immutable Google subject binding.
   * OAuth tokens are opaque; a self-asserted object is not proof of delegation. */
  readonly credentialFor: (caller: Caller) => Promise<unknown>;
  /** Trusted source inventory. Unknown classification/residency/tenant denies the file. */
  readonly policyFor: (file: DriveFileMetadata) => Promise<DriveDocumentPolicy | undefined>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly maxContentBytes?: number;
  readonly onAccess?: (event: DriveAccessEvent) => void;
};
export class DelegatedDriveError extends RetrievalError {
  constructor(
    readonly code: 'identity' | 'credential' | 'policy' | 'transport' | 'response' | 'limit',
  ) {
    super(`delegated Drive retrieval denied: ${code}`);
    this.name = 'DelegatedDriveError';
  }
}

type Session = {
  options: DriveAdapterOptions;
  credential: DelegatedCredential;
  context: SearchContext;
  load: typeof fetch;
  clock: () => number;
  signal: AbortSignal;
};

/** Standalone SearchPort. No route selection, indexing, shared identity or result cache. */
export function createDriveAdapter(options: DriveAdapterOptions): SearchPort {
  const clock = options.now ?? Date.now;
  return {
    async search(input, query) {
      const context = validatedContext(options, input);
      if (!input.allowedSources.includes('drive') || !query.trim()) return [];
      if (query.length > 4096 || input.resultCountLimit > 100)
        throw new DelegatedDriveError('limit');
      const credential = await resolveCredential(options, clock);
      const session: Session = {
        options,
        credential,
        context,
        clock,
        load: options.fetch ?? fetch,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      };
      const ids = await listIds(session, query);
      const hits: SearchHit[] = [];
      for (const id of ids) {
        const hit = await readHit(session, id);
        if (hit) hits.push(hit);
        if (hits.length >= input.resultCountLimit) break;
      }
      assertFresh(session);
      return hits;
    },
  };
}

function validatedContext(options: DriveAdapterOptions, input: SearchContext): SearchContext {
  const context = searchContextSchema.safeParse(input);
  if (
    !context.success ||
    input.userSubject !== options.caller.sub ||
    !options.caller.assertion.trim()
  ) {
    throw new DelegatedDriveError('identity');
  }
  return context.data;
}

async function resolveCredential(options: DriveAdapterOptions, clock: () => number) {
  let raw: unknown;
  try {
    raw = await options.credentialFor(options.caller);
  } catch {
    throw new DelegatedDriveError('credential');
  }
  const parsed = credentialSchema.safeParse(raw);
  if (!parsed.success) throw new DelegatedDriveError('credential');
  const credential = parsed.data;
  if (
    credential.callerSubject !== options.caller.sub ||
    credential.googleSubject !== options.caller.sub ||
    credential.googleSubject.endsWith('.gserviceaccount.com') ||
    !credential.scopes.includes(readScope) ||
    credential.expiresAt <= clock()
  ) {
    throw new DelegatedDriveError('credential');
  }
  return credential;
}

function assertFresh(session: Session) {
  if (session.credential.expiresAt <= session.clock()) throw new DelegatedDriveError('credential');
  if (session.signal.aborted) throw new DelegatedDriveError('transport');
}

async function request(session: Session, url: URL): Promise<Response> {
  assertFresh(session);
  try {
    const response = await session.load(url, {
      headers: { authorization: `Bearer ${session.credential.accessToken}` },
      signal: session.signal,
      redirect: 'error',
    });
    if (response.status === 401) {
      await response.body?.cancel();
      throw new DelegatedDriveError('credential');
    }
    if (response.ok || response.status === 403 || response.status === 404) return response;
    await response.body?.cancel();
    throw new DelegatedDriveError('transport');
  } catch (error) {
    if (error instanceof DelegatedDriveError) throw error;
    throw new DelegatedDriveError('transport');
  }
}

async function bodyText(session: Session, response: Response, limit: number): Promise<string> {
  if (!response.body) throw new DelegatedDriveError('response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      assertFresh(session);
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new DelegatedDriveError('limit');
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof DelegatedDriveError) throw error;
    throw new DelegatedDriveError('response');
  } finally {
    reader.releaseLock();
  }
}

async function jsonBody(session: Session, response: Response): Promise<unknown> {
  const text = await bodyText(session, response, 1_000_000);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DelegatedDriveError('response');
  }
}

async function listIds(session: Session, query: string): Promise<readonly string[]> {
  const ids = new Set<string>();
  const pages = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < (session.options.maxPages ?? 10); page += 1) {
    const url = new URL('/drive/v3/files', origin);
    const escaped = query.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    url.searchParams.set('q', `trashed = false and fullText contains '${escaped}'`);
    url.searchParams.set('fields', 'files(id),nextPageToken,incompleteSearch');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await request(session, url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new DelegatedDriveError('transport');
    }
    const listing = await readListing(session, response);
    for (const file of listing.files) ids.add(file.id);
    pageToken = listing.nextPageToken;
    if (!pageToken) return [...ids];
    if (pages.has(pageToken)) throw new DelegatedDriveError('response');
    pages.add(pageToken);
  }
  throw new DelegatedDriveError('limit');
}

async function readListing(session: Session, response: Response) {
  const parsed = listingSchema.safeParse(await jsonBody(session, response));
  if (!parsed.success || parsed.data.incompleteSearch) throw new DelegatedDriveError('response');
  return parsed.data;
}

function event(session: Session, id: string, decision: DriveAccessEvent['decision']) {
  session.options.onAccess?.({ sourceObjectId: id, decision });
}

async function permitted(session: Session, response: Response, id: string): Promise<boolean> {
  if (response.ok) return true;
  await response.body?.cancel();
  event(session, id, response.status === 403 ? 'permission-denied' : 'not-found-or-denied');
  return false;
}

async function metadata(session: Session, id: string): Promise<DriveFileMetadata | undefined> {
  const url = new URL(`/drive/v3/files/${encodeURIComponent(id)}`, origin);
  url.searchParams.set('fields', fileFields);
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await request(session, url);
  if (!(await permitted(session, response, id))) return undefined;
  const parsed = metadataSchema.safeParse(await jsonBody(session, response));
  if (!parsed.success || parsed.data.id !== id) throw new DelegatedDriveError('response');
  if (parsed.data.trashed || !parsed.data.capabilities.canDownload) {
    event(session, id, 'permission-denied');
    return undefined;
  }
  return parsed.data;
}

async function policyAllows(session: Session, file: DriveFileMetadata): Promise<boolean> {
  let policy: DriveDocumentPolicy | undefined;
  try {
    policy = await session.options.policyFor(file);
  } catch {
    throw new DelegatedDriveError('policy');
  }
  if (!policy) return false;
  const level = CLASSIFICATIONS.indexOf(policy.classification);
  return (
    policy.enterpriseId === session.context.enterpriseId &&
    session.context.allowedRegions.includes(policy.region) &&
    level >= 0 &&
    level <= CLASSIFICATIONS.indexOf(session.context.classificationCeiling)
  );
}

async function readHit(session: Session, id: string): Promise<SearchHit | undefined> {
  const file = await metadata(session, id);
  if (!file) return undefined;
  if (!(await policyAllows(session, file))) {
    event(session, id, policyDenied);
    return undefined;
  }
  const url = contentUrl(file);
  if (!url) {
    event(session, id, policyDenied);
    return undefined;
  }
  const response = await request(session, url);
  if (!(await permitted(session, response, id))) return undefined;
  const text = await bodyText(session, response, session.options.maxContentBytes ?? 1_000_000);
  const after = await metadata(session, id);
  if (!after) return undefined;
  if (
    after.version !== file.version ||
    after.mimeType !== file.mimeType ||
    after.name !== file.name
  ) {
    event(session, id, 'changed');
    return undefined;
  }
  if (!(await policyAllows(session, after))) {
    event(session, id, policyDenied);
    return undefined;
  }
  assertFresh(session);
  return toHit(session, after, text);
}

function toHit(session: Session, file: DriveFileMetadata, text: string): SearchHit {
  const id = file.id;
  const retrievedAt = new Date(session.clock()).toISOString();
  const decision = createHash('sha256')
    .update(JSON.stringify([session.context.userSubject, id, file.version, retrievedAt]))
    .digest('hex');
  event(session, id, 'allowed');
  return {
    sourceObjectId: id,
    sourceUri: `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`,
    title: file.name,
    text,
    excerpt: text.slice(0, 160) || file.name,
    etag: file.version,
    retrievedAt,
    accessDecisionId: `drive-delegated:${decision}`,
  };
}

function contentUrl(file: DriveFileMetadata): URL | undefined {
  const isDoc = file.mimeType === 'application/vnd.google-apps.document';
  if (!isDoc && file.mimeType !== 'text/plain') return undefined;
  const url = new URL(
    `/drive/v3/files/${encodeURIComponent(file.id)}${isDoc ? '/export' : ''}`,
    origin,
  );
  url.searchParams.set(isDoc ? 'mimeType' : 'alt', isDoc ? 'text/plain' : 'media');
  return url;
}
