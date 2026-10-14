import { header } from './http.js';

import type { Request, Reply } from './http.js';
export type GoogleIdentity = {
  readonly subject: string;
  readonly scopes: readonly string[];
  readonly revoked?: boolean;
};
export type GoogleFakeOptions = {
  readonly tokens: ReadonlyMap<string, GoogleIdentity>;
  readonly failures?: number[];
  /** Commit the next write and return 503, simulating a lost response. */
  readonly lostResponses?: { remaining: number };
};
export function googleIdentity(
  request: Request,
  options: GoogleFakeOptions,
  scope: string,
): GoogleIdentity | Reply {
  const bearer = header(request.headers, 'authorization');
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
  const identity = token === undefined ? undefined : options.tokens.get(token);
  if (!identity || identity.revoked) return { status: 401, body: { error: 'unauthorized' } };
  if (!identity.scopes.includes(scope)) return { status: 403, body: { error: 'forbidden' } };
  return identity;
}
export function googleFailure(options: GoogleFakeOptions): Reply | undefined {
  const status = options.failures?.shift();
  return status === undefined
    ? undefined
    : { status, body: { error: 'injected failure' }, headers: { 'retry-after': '0' } };
}
export function googleBody(request: Request): unknown {
  if (request.body.byteLength > 150_000) return undefined;
  try {
    return JSON.parse(request.body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
export const googleDenied = { status: 403, body: { error: 'forbidden' } };
export const googleInvalid = { status: 400, body: { error: 'invalid_request' } };
