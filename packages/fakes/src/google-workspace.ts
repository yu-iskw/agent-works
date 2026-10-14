import { oauthConnectionSchema } from '@agent-works/domain';

import { createOAuth } from './fake-oauth.js';
import { createGoogleCalendar } from './google-calendar.js';
import { createGoogleDocs } from './google-docs.js';
import { createGoogleGmail } from './google-gmail.js';
import { header } from './http.js';

import type { GoogleIdentity } from './google-auth.js';
import type { Handler } from './http.js';

/** Offline dev server: token references are opaque fake bearer credentials.
 * Every request rechecks the same OAuth store, including revocation and expiry. */
export function createGoogleWorkspace(): Handler {
  const oauth = createOAuth();
  const tokens = new Map<string, GoogleIdentity>();
  const docs = createGoogleDocs({
    tokens,
    destinations: new Map([
      ['alice-folder', ['alice']],
      ['bob-folder', ['bob']],
    ]),
  });
  const calendar = createGoogleCalendar({ tokens });
  const gmail = createGoogleGmail({ tokens });
  return async (request) => {
    if (request.url.pathname.startsWith('/oauth/')) return oauth(request);
    const bearer = header(request.headers, 'authorization');
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
    if (token) {
      tokens.delete(token);
      const reply = await oauth({
        ...request,
        method: 'GET',
        url: new URL(`/oauth/tokens/${encodeURIComponent(token)}`, request.url),
      });
      const connection = oauthConnectionSchema.safeParse(reply.body);
      if (
        reply.status === 200 &&
        connection.success &&
        connection.data.status === 'active' &&
        Date.parse(connection.data.expiresAt) > Date.now()
      ) {
        tokens.set(token, {
          subject: connection.data.subject,
          scopes: connection.data.scope.split(/\s+/),
        });
      }
    }
    if (request.url.pathname.startsWith('/documents')) return docs.handler(request);
    if (request.url.pathname.startsWith('/calendars/')) return calendar.handler(request);
    return gmail.handler(request);
  };
}
