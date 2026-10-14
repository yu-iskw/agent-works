import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { IncomingMessage } from 'node:http';
const cookieName = 'aw_schedules_csrf';
function cookie(request: IncomingMessage): string | undefined {
  const token = request.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return token !== undefined && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function scheduleCsrf(request: IncomingMessage): string {
  return cookie(request) ?? randomBytes(32).toString('hex');
}
export function scheduleCookie(token: string): string {
  return `${cookieName}=${token}; Path=/schedules; HttpOnly; SameSite=Strict`;
}
export function scheduleCsrfValid(request: IncomingMessage, form: URLSearchParams): boolean {
  const token = cookie(request);
  const posted = form.get('csrfToken');
  if (token === undefined || posted === null || !/^[a-f0-9]{64}$/.test(posted)) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    const parsed = URL.parse(origin);
    if (parsed === null || parsed.host !== request.headers.host) return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(posted));
}
