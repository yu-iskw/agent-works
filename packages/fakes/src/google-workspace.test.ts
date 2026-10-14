import { createHash } from 'node:crypto';

import { workspaceScopes } from '@agent-works/domain/workspace-tools';
import { describe, expect, it } from 'vitest';

import { googleFakeTransport } from './google-transport.js';
import { createGoogleWorkspace } from './google-workspace.js';

function harness() {
  const load = googleFakeTransport(createGoogleWorkspace());
  const base = 'http://127.0.0.1';
  const post = (path: string, body: unknown, token?: string) =>
    load(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token
          ? { authorization: `Bearer ${token}`, 'idempotency-key': `${token}:${path}` }
          : {}),
      },
      body: JSON.stringify(body),
    });
  async function connect(subject: string, scope: string) {
    const verifier = 'A'.repeat(43);
    const state = `state-${subject}`;
    const code = await post('/oauth/authorize', {
      subject,
      provider: 'google',
      state,
      scope,
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      codeChallengeMethod: 'S256',
    });
    const issued = (await code.json()) as { code: string };
    const response = await post('/oauth/token', {
      provider: 'google',
      state,
      code: issued.code,
      codeVerifier: verifier,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { tokenRef: string }).tokenRef;
  }
  return { load, post, connect };
}

describe('dev workspace fake server', () => {
  it('uses caller-owned OAuth grants for Docs ACLs and rechecks revocation', async () => {
    const h = harness();
    const token = await h.connect('alice', workspaceScopes['docs.createDraft']);
    const payload = { title: 'Prep', body: 'Agenda', destinationId: 'alice-folder' };
    expect((await h.post('/documents', payload, token)).status).toBe(201);
    expect(
      (await h.post('/documents', { ...payload, destinationId: 'bob-folder' }, token)).status,
    ).toBe(403);
    expect((await h.post('/oauth/revoke', { tokenRef: token })).status).toBe(200);
    expect((await h.post('/documents', payload, token)).status).toBe(401);
  });
  it('routes Calendar and Gmail and denies unrelated scopes', async () => {
    const h = harness();
    const token = await h.connect('alice', workspaceScopes['calendar.listEvents']);
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await h.load(
          'http://127.0.0.1/calendars/primary/events?timeMin=2026-01-01T00:00:00Z&timeMax=2027-01-01T00:00:00Z',
          { headers },
        )
      ).status,
    ).toBe(200);
    expect((await h.load('http://127.0.0.1/calendars/bob/events', { headers })).status).toBe(403);
    expect((await h.load('http://127.0.0.1/users/me/threads?q=meeting', { headers })).status).toBe(
      403,
    );
    const gmail = await h.connect('bob', workspaceScopes['gmail.searchThreads']);
    expect(
      (
        await h.load('http://127.0.0.1/users/me/threads?q=meeting', {
          headers: { authorization: `Bearer ${gmail}` },
        })
      ).status,
    ).toBe(200);
  });
});
