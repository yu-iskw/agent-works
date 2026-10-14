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
    // Comma-separated public origins; proxy Host headers identify the internal web service.
    const trustedOrigins =
      process.env.ADMIN_TRUSTED_ORIGINS ??
      (process.env.NODE_ENV === 'production'
        ? ''
        : 'http://127.0.0.1:8081,http://localhost:8081,http://127.0.0.1:8085,http://localhost:8085');
    if (
      !trustedOrigins
        .split(',')
        .map((value) => value.trim())
        .includes(origin)
    )
      return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(posted));
}
