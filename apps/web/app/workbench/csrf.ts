import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { IncomingMessage } from 'node:http';

const cookieName = 'aw_wb_csrf';
const tokenPattern = /^[a-f0-9]{64}$/;

export function csrfToken(request: IncomingMessage): string {
  return cookieToken(request) ?? randomBytes(32).toString('hex');
}

export function csrfCookie(token: string): string {
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

function cookieToken(request: IncomingMessage): string | undefined {
  const token = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);
  return token !== undefined && tokenPattern.test(token) ? token : undefined;
}

export function trustedOrigins(
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return (env.WEB_TRUSTED_ORIGINS ?? 'http://localhost:8180,http://127.0.0.1:8180')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Double-submit cookie plus an Origin (or Referer) allowlist check on every state change. */
export function csrfValid(
  request: IncomingMessage,
  form: URLSearchParams,
  origins: readonly string[],
): boolean {
  const token = cookieToken(request);
  const posted = form.get('csrf');
  if (token === undefined || posted === null || !tokenPattern.test(posted)) return false;
  const origin = request.headers.origin ?? refererOrigin(request.headers.referer);
  if (origin === undefined || !origins.includes(origin)) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(posted));
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (referer === undefined) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
