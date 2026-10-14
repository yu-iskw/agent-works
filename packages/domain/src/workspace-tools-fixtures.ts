export const workspacePayloadFixtures = {
  'docs.createDraft': { title: 'Brief', destinationId: 'folder-1', body: 'Draft text' },
  'calendar.listEvents': { timeMin: '2026-10-15T00:00:00Z', timeMax: '2026-10-16T00:00:00Z' },
  'calendar.createEvent': {
    summary: 'Review',
    description: 'Agenda',
    start: '2026-10-15T10:00:00Z',
    end: '2026-10-15T11:00:00Z',
    attendees: ['alice@example.test'],
  },
  'gmail.searchThreads': { query: 'meeting' },
  'gmail.createDraft': { to: ['alice@example.test'], subject: 'Review', body: 'Draft only' },
} as const;
