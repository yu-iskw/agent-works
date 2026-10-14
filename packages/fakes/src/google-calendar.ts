import {
  calendarCreateSchema,
  calendarListSchema,
  workspaceScopes,
} from '../../domain/dist/workspace-tools.js';

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
import type { CalendarCreate } from '../../domain/dist/workspace-tools.js';
export type FakeCalendarEvent = CalendarCreate & { readonly id: string; readonly owner: string };
export function createGoogleCalendar(
  options: GoogleFakeOptions & { readonly seed?: readonly FakeCalendarEvent[] },
) {
  const events: FakeCalendarEvent[] = structuredClone([...(options.seed ?? [])]);
  const keys = googleIdempotency();
  const handler: Handler = (request) => {
    const read = request.method === 'GET';
    const scope = workspaceScopes[read ? 'calendar.listEvents' : 'calendar.createEvent'];
    const broadened = {
      ...options,
      tokens: new Map(
        [...options.tokens].map(([key, value]) => [
          key,
          {
            ...value,
            scopes: value.scopes.includes(workspaceScopes['calendar.createEvent'])
              ? [...value.scopes, workspaceScopes['calendar.listEvents']]
              : value.scopes,
          },
        ]),
      ),
    };
    const identity = googleIdentity(request, broadened, scope);
    if ('status' in identity) return identity;
    const match = /^\/calendars\/([^/]+)\/events$/.exec(request.url.pathname);
    if (!match || !['GET', 'POST'].includes(request.method)) return { status: 404, body: {} };
    const calendarId = decodeURIComponent(match[1]);
    if (calendarId !== 'primary' && calendarId !== identity.subject) return googleDenied;
    const failure = googleFailure(options);
    if (failure) return failure;
    if (read) {
      return listCalendar(request, calendarId, identity.subject, events);
    }
    const parsed = calendarCreateSchema.safeParse(googleBody(request));
    if (
      !parsed.success ||
      parsed.data.calendarId !== calendarId ||
      request.url.searchParams.get('sendUpdates') !== 'none'
    )
      return googleInvalid;
    return keys.create(request, options, identity.subject, parsed.data, () => {
      const id = `event-${events.length + 1}`;
      events.push({ ...parsed.data, id, owner: identity.subject });
      return { status: 201, body: { id, kind: 'event' } };
    });
  };
  return { handler, events: () => structuredClone(events) };
}

function listCalendar(
  request: Request,
  calendarId: string,
  subject: string,
  events: readonly FakeCalendarEvent[],
) {
  const parsed = calendarListSchema.safeParse({
    calendarId,
    timeMin: request.url.searchParams.get('timeMin'),
    timeMax: request.url.searchParams.get('timeMax'),
    limit: Number(request.url.searchParams.get('limit') ?? 20),
  });
  if (!parsed.success) return googleInvalid;
  const body = events
    .filter(
      (event) =>
        event.owner === subject &&
        Date.parse(event.end) > Date.parse(parsed.data.timeMin) &&
        Date.parse(event.start) < Date.parse(parsed.data.timeMax),
    )
    .slice(0, parsed.data.limit)
    .map((event) => ({
      id: event.id,
      title: event.summary,
      body: event.description,
      classification: 'INTERNAL',
    }));
  return { status: 200, body };
}
