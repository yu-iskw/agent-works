import { docsDraftSchema, workspaceScopes } from '../../domain/dist/workspace-tools.js';

import {
  googleBody,
  googleDenied,
  googleFailure,
  googleIdentity,
  googleInvalid,
} from './google-auth.js';
import { googleIdempotency } from './google-idempotency.js';

import type { GoogleFakeOptions } from './google-auth.js';
import type { Handler } from './http.js';
import type { DocsDraft } from '../../domain/dist/workspace-tools.js';
type FakeDocument = DocsDraft & { readonly id: string; readonly owner: string };
export function createGoogleDocs(
  options: GoogleFakeOptions & { readonly destinations: ReadonlyMap<string, readonly string[]> },
) {
  const documents: FakeDocument[] = [];
  const keys = googleIdempotency();
  const handler: Handler = (request) => {
    const identity = googleIdentity(request, options, workspaceScopes['docs.createDraft']);
    if ('status' in identity) return identity;
    if (request.method !== 'POST' || request.url.pathname !== '/documents')
      return { status: 404, body: {} };
    const parsed = docsDraftSchema.safeParse(googleBody(request));
    if (!parsed.success) return googleInvalid;
    if (!options.destinations.get(parsed.data.destinationId)?.includes(identity.subject))
      return googleDenied;
    const failure = googleFailure(options);
    if (failure) return failure;
    return keys.create(request, options, identity.subject, parsed.data, () => {
      const id = `doc-${documents.length + 1}`;
      documents.push({ ...parsed.data, owner: identity.subject, id });
      return { status: 201, body: { id, kind: 'document' } };
    });
  };
  return { handler, documents: () => structuredClone(documents) };
}
