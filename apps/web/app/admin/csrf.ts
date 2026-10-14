import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { IncomingMessage } from 'node:http';

const cookieName = 'aw_admin_csrf';
export function csrfToken(request: IncomingMessage): string {
  return cookieToken(request) ?? randomBytes(32).toString('hex');
}
export function csrfCookie(token: string): string {
  return `${cookieName}=${token}; Path=/admin; HttpOnly; SameSite=Strict`;
}
function cookieToken(request: IncomingMessage): string | undefined {
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return token !== undefined && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function csrfValid(request: IncomingMessage, form: URLSearchParams): boolean {
  const token = cookieToken(request);
  const posted = form.get('csrfToken');
  if (token === undefined || posted === null || !/^[a-f0-9]{64}$/.test(posted)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    const parsed = URL.parse(origin);
    if (
      parsed === null ||
      request.headers.host === undefined ||
      parsed.host !== request.headers.host
    )
      return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(posted));
}
