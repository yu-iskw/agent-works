import { describe, expect, it } from 'vitest';

import { workspacePayloadFixtures } from './workspace-tools-fixtures.js';
import { parseWorkspacePayload, workspacePayloadHash, workspaceTarget } from './workspace-tools.js';
describe('workspace canonical payload binding', () => {
  it.each(Object.entries(workspacePayloadFixtures))(
    'hashes normalized %s payload deterministically',
    (name, payload) => {
      const tool = name as keyof typeof workspacePayloadFixtures;
      const normalized = parseWorkspacePayload(tool, payload);
      expect(workspacePayloadHash(tool, payload)).toBe(workspacePayloadHash(tool, normalized));
      expect(workspacePayloadHash(tool, payload)).toMatch(/^[a-f0-9]{64}$/);
    },
  );
  it('includes the document destination and body in the digest', () => {
    const payload = workspacePayloadFixtures['docs.createDraft'];
    const first = workspacePayloadHash('docs.createDraft', payload);
    expect(
      workspacePayloadHash('docs.createDraft', { ...payload, destinationId: 'other' }),
    ).not.toBe(first);
    expect(workspacePayloadHash('docs.createDraft', { ...payload, body: 'edited' })).not.toBe(
      first,
    );
  });
  it('includes attendees and timing in event digest', () => {
    const payload = workspacePayloadFixtures['calendar.createEvent'];
    const first = workspacePayloadHash('calendar.createEvent', payload);
    expect(
      workspacePayloadHash('calendar.createEvent', { ...payload, attendees: ['bob@example.test'] }),
    ).not.toBe(first);
    expect(
      workspacePayloadHash('calendar.createEvent', { ...payload, end: '2026-10-15T12:00:00Z' }),
    ).not.toBe(first);
  });
  it('uses canonical object key ordering', () => {
    const payload = workspacePayloadFixtures['docs.createDraft'];
    expect(workspacePayloadHash('docs.createDraft', payload)).toBe(
      workspacePayloadHash('docs.createDraft', {
        body: payload.body,
        destinationId: payload.destinationId,
        title: payload.title,
      }),
    );
  });
  it('binds Gmail recipient order without silently reordering recipients', () => {
    const payload = workspacePayloadFixtures['gmail.createDraft'];
    expect(
      workspacePayloadHash('gmail.createDraft', {
        ...payload,
        to: ['alice@example.test', 'bob@example.test'],
      }),
    ).not.toBe(
      workspacePayloadHash('gmail.createDraft', {
        ...payload,
        to: ['bob@example.test', 'alice@example.test'],
      }),
    );
  });
  it('resolves explicit targets for resource policy', () => {
    expect(workspaceTarget('docs.createDraft', workspacePayloadFixtures['docs.createDraft'])).toBe(
      'folder-1',
    );
    expect(
      workspaceTarget('calendar.createEvent', workspacePayloadFixtures['calendar.createEvent']),
    ).toBe('primary');
    expect(
      workspaceTarget('gmail.createDraft', workspacePayloadFixtures['gmail.createDraft']),
    ).toBe('me');
  });
  it.each(Object.entries(workspacePayloadFixtures))(
    'rejects forged caller identity in %s',
    (name, payload) => {
      expect(() =>
        parseWorkspacePayload(name as keyof typeof workspacePayloadFixtures, {
          ...payload,
          owner: 'bob',
        }),
      ).toThrow();
    },
  );
  it('cannot parse or hash a send payload', () => {
    expect(() => parseWorkspacePayload('gmail.send', {})).toThrow('POLICY_DENIED');
    expect(() => workspacePayloadHash('gmail.send', {})).toThrow('POLICY_DENIED');
  });
});
