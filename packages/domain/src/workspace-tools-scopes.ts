export const workspaceToolNames = [
  'docs.createDraft',
  'calendar.listEvents',
  'calendar.createEvent',
  'gmail.searchThreads',
  'gmail.createDraft',
  'gmail.send',
] as const;
export type WorkspaceToolName = (typeof workspaceToolNames)[number];
export const workspaceScopes = {
  'docs.createDraft': 'https://www.googleapis.com/auth/drive.file',
  'calendar.listEvents': 'https://www.googleapis.com/auth/calendar.events.readonly',
  'calendar.createEvent': 'https://www.googleapis.com/auth/calendar.events',
  'gmail.searchThreads': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.createDraft': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
} as const;
