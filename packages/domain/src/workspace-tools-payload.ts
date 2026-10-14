import { canonicalPayloadSha256 } from './canonical-hash.js';
import {
  docsDraftSchema,
  calendarListSchema,
  calendarCreateSchema,
  gmailSearchSchema,
  gmailDraftSchema,
} from './workspace-tools-schema.js';

import type {
  DocsDraft,
  CalendarList,
  CalendarCreate,
  GmailSearch,
  GmailDraft,
} from './workspace-tools-schema.js';
import type { WorkspaceToolName } from './workspace-tools-scopes.js';

type WorkspacePayload = DocsDraft | CalendarList | CalendarCreate | GmailSearch | GmailDraft;

export function parseWorkspacePayload(name: WorkspaceToolName, payload: unknown): WorkspacePayload {
  switch (name) {
    case 'docs.createDraft':
      return docsDraftSchema.parse(payload);
    case 'calendar.listEvents':
      return calendarListSchema.parse(payload);
    case 'calendar.createEvent':
      return calendarCreateSchema.parse(payload);
    case 'gmail.searchThreads':
      return gmailSearchSchema.parse(payload);
    case 'gmail.createDraft':
      return gmailDraftSchema.parse(payload);
    case 'gmail.send':
      throw new Error('POLICY_DENIED');
  }
}
/** Hash the validated payload: the runner, approval view and adapter use these exact defaults. */
export function workspacePayloadHash(name: WorkspaceToolName, payload: unknown): string {
  return canonicalPayloadSha256(parseWorkspacePayload(name, payload));
}
export function workspaceTarget(name: WorkspaceToolName, payload: unknown): string {
  const value = parseWorkspacePayload(name, payload);
  if ('destinationId' in value) return value.destinationId;
  if ('calendarId' in value) return value.calendarId;
  return 'me';
}
