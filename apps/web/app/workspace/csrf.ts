import { timingSafeEqual } from 'node:crypto';

import type { IncomingHttpHeaders } from 'node:http';

export type CsrfInput = {
  readonly headers: Pick<IncomingHttpHeaders, 'origin' | 'referer' | 'content-type'>;
  /** The `csrf` form field or the `x-csrf-token` header, whichever the path carries. */
  readonly presented: string | null | undefined;
  readonly sessionCsrf: string;
  readonly origins: ReadonlySet<string>;
  /** JSON routes also demand a JSON content type, so an HTML form can never reach them. */
  readonly json: boolean;
};

export function same(a: string | null | undefined, b: string): boolean {
  if (a === null || a === undefined) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function originOf(headers: CsrfInput['headers']): string | undefined {
  if (headers.origin !== undefined) return headers.origin;
  return headers.referer === undefined ? undefined : URL.parse(headers.referer)?.origin;
}

export function csrfOk({ headers, presented, sessionCsrf, origins, json }: CsrfInput): boolean {
  if (!same(presented, sessionCsrf)) return false;
  const origin = originOf(headers);
  if (origin === undefined || !origins.has(origin)) return false;
  return !json || (headers['content-type'] ?? '').toLowerCase().startsWith('application/json');
}
