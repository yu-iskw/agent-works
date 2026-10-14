import {
  calendarCreateSchema,
  workspaceReceiptSchema,
  calendarListSchema,
  workspaceSourcesSchema,
} from '@agent-works/domain/workspace-tools';

import { ConnectorError } from '../errors.js';

import type { CallerCredential, GoogleHttp } from '../google-http.js';
export function createCalendarAdapter(http: GoogleHttp) {
  return {
    async listEvents(credential: CallerCredential, input: unknown, signal?: AbortSignal) {
      const body = calendarListSchema.parse(input);
      const query = new URLSearchParams({
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        limit: String(body.limit),
      });
      const response = await http.request({
        method: 'GET',
        path: `/calendars/${encodeURIComponent(body.calendarId)}/events?${query}`,
        credential,
        signal,
      });
      return sources(response);
    },
    async createEvent(
      credential: CallerCredential,
      input: unknown,
      key: string,
      signal?: AbortSignal,
    ) {
      const body = calendarCreateSchema.parse(input);
      const response = await http.request({
        method: 'POST',
        path: `/calendars/${encodeURIComponent(body.calendarId)}/events?sendUpdates=none`,
        credential,
        body,
        idempotencyKey: key,
        signal,
      });
      const parsed = workspaceReceiptSchema.safeParse(response);
      if (!parsed.success || parsed.data.kind !== 'event')
        throw new ConnectorError('INVALID_RESPONSE', 502);
      return parsed.data;
    },
  };
}
function sources(value: unknown) {
  const parsed = workspaceSourcesSchema.safeParse(value);
  if (!parsed.success) throw new ConnectorError('INVALID_RESPONSE', 502);
  return parsed.data;
}
