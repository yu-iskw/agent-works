import {
  gmailDraftSchema,
  gmailSearchSchema,
  workspaceScopes,
} from '@agent-works/domain/workspace-tools';

import {
  googleBody,
  googleDenied,
  googleFailure,
  googleIdentity,
  googleInvalid,
} from './google-auth.js';
import { googleIdempotency } from './google-idempotency.js';

import type { GoogleFakeOptions } from './google-auth.js';
import type { Handler, Request } from './http.js';
import type { GmailDraft } from '@agent-works/domain/workspace-tools';
export type FakeMailThread = {
  readonly id: string;
  readonly owner: string;
  readonly subject: string;
  readonly body: string;
};
export function createGoogleGmail(
  options: GoogleFakeOptions & { readonly seed?: readonly FakeMailThread[] },
) {
  const threads = structuredClone([...(options.seed ?? [])]);
  const drafts: (GmailDraft & { id: string; owner: string })[] = [];
  const keys = googleIdempotency();
  const handler: Handler = (request) => {
    const read = request.method === 'GET';
    const identity = googleIdentity(
      request,
      options,
      workspaceScopes[read ? 'gmail.searchThreads' : 'gmail.createDraft'],
    );
    if ('status' in identity) return identity;
    if (deniedPath(request.url.pathname)) return googleDenied;
    const failure = googleFailure(options);
    if (failure) return failure;
    if (read && request.url.pathname === '/users/me/threads') {
      return searchMail(request, identity.subject, threads);
    }
    if (request.method !== 'POST' || request.url.pathname !== '/users/me/drafts')
      return { status: 404, body: {} };
    const parsed = gmailDraftSchema.safeParse(googleBody(request));
    if (!parsed.success) return googleInvalid;
    if (
      parsed.data.threadId &&
      !threads.some(
        (thread) => thread.id === parsed.data.threadId && thread.owner === identity.subject,
      )
    )
      return googleDenied;
    return keys.create(request, options, identity.subject, parsed.data, () => {
      const id = `draft-${drafts.length + 1}`;
      drafts.push({ ...parsed.data, owner: identity.subject, id });
      return { status: 201, body: { id, kind: 'draft' } };
    });
  };
  return { handler, drafts: () => structuredClone(drafts) };
}

function searchMail(request: Request, subject: string, threads: readonly FakeMailThread[]) {
  const parsed = gmailSearchSchema.safeParse({
    query: request.url.searchParams.get('q'),
    limit: Number(request.url.searchParams.get('limit') ?? 20),
  });
  if (!parsed.success) return googleInvalid;
  return {
    status: 200,
    body: threads
      .filter(
        (thread) =>
          thread.owner === subject &&
          `${thread.subject} ${thread.body}`
            .toLowerCase()
            .includes(parsed.data.query.toLowerCase()),
      )
      .slice(0, parsed.data.limit)
      .map((thread) => ({
        id: thread.id,
        title: thread.subject,
        body: thread.body,
        classification: 'CONFIDENTIAL',
      })),
  };
}

function deniedPath(path: string): boolean {
  return path.includes('send') || !path.startsWith('/users/me/');
}
