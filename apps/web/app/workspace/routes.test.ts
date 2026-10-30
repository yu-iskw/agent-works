import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/contract.js';
import { createM1Handler } from '../m1/handler.js';

import type { PreferencesStore } from './preferences.js';
import type { Bootstrap, Preferences, PreferencesPatch } from '../../shared/contract.js';
import type { Readiness, SegmentClient } from '../m1/api.js';
import type { WebConfig } from '../m1/config.js';
import type { Identity, Session } from '../m1/identity.js';
import type { TeammateView } from '@agent-works/domain/teamwork';
import type { AddressInfo } from 'node:net';

const T = '11111111-2222-4333-8444-555555555555';
const GONE = '99999999-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const CSRF = 'c'.repeat(64);
const ORIGIN = 'http://localhost:8280';

const session: Session = {
  sub: 'local-test:alice',
  email: 'alice@local.test',
  name: 'alice',
  idp: 'local-test',
  csrf: CSRF,
  expiresAt: new Date('2099-01-01'),
};

const config: WebConfig = {
  publicUrl: ORIGIN,
  identity: 'local-test',
  segments: [{ id: 'alpha', name: 'Alpha', url: 'http://api-alpha:8080' }],
  databaseUrl: '',
  keyDir: '',
  google: undefined,
  members: new Map([['alpha', new Set(['alice@local.test'])]]),
  e2eSecret: undefined,
  missing: [],
};

const readiness: Readiness = {
  segment: { id: 'alpha', name: 'Alpha' },
  member: { sub: session.sub, email: session.email },
  identity: 'local-test',
  sourceMode: 'fixture',
  missingConfig: [],
  model: {
    modelId: 'gemini-3.8-flash',
    mode: 'vertex',
    state: 'ready',
    credentials: 'adc',
    callsUsed: 7,
    callsLimit: 300,
    concurrency: 2,
    lastCall: null,
    errorCode: null,
    remediation: null,
  },
  connections: [],
  capabilities: [],
  readOnly: false,
  inbox: { question: 1, approval: 2 },
  sources: {
    repositories: [],
    issue: null,
    pinnedRef: null,
    dataset: null,
    driveConfigured: false,
  },
};

const teammate: TeammateView = {
  id: T,
  name: 'Haru',
  role: 'Research',
  instructions: '',
  template: { id: T, version: 1, name: 'Researcher' },
  skills: [],
  capabilities: [],
  version: 1,
  origin: 'template',
  conversationId: CONV,
  appearance: { avatar: null, accent: null },
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

type Posted = { readonly conversationId: string; readonly body: unknown };

function fakeApi(input: { readonly replyPending: boolean; readonly paged: boolean }) {
  const posted: Posted[] = [];
  const api = {
    segmentFor: (s: Session, id: string) =>
      s.email === session.email ? config.segments.find((seg) => seg.id === id) : undefined,
    me: () => Promise.resolve({ ok: true, value: readiness }),
    teammateRows: () =>
      Promise.resolve({
        ok: true,
        value: { apiVersion: 'teamwork.v1', teammates: [{ ...teammate, working: true, extra: 1 }] },
      }),
    teammate: (_s: Session, _seg: string, id: string) =>
      Promise.resolve(
        id === T
          ? {
              ok: true,
              value: {
                teammate,
                conversation: {
                  id: CONV,
                  teammateId: T,
                  messages: [],
                  pendingReply: false,
                  tasks: [],
                },
              },
            }
          : { ok: false, status: 404, error: 'not_found' },
      ),
    conversationPage: () =>
      Promise.resolve(
        input.paged
          ? {
              ok: true,
              value: {
                apiVersion: 'teamwork.v1',
                id: CONV,
                teammateId: T,
                messages: [],
                nextCursor: 'bmV4dA',
                prevCursor: null,
                reply: 'generating',
                tasks: [],
              },
            }
          : { ok: false, status: 404, error: 'not_found' },
      ),
    postMessage: (_s: Session, _seg: string, conversationId: string, body: unknown) => {
      posted.push({ conversationId, body });
      return Promise.resolve(
        input.replyPending
          ? { ok: false, status: 409, error: 'reply_pending' }
          : { ok: true, value: { accepted: true } },
      );
    },
    catalog: () => Promise.resolve({ ok: true, value: { templates: [], skills: [] } }),
    inbox: () => Promise.resolve({ ok: true, value: { items: [] } }),
  };
  return { api: api as unknown as SegmentClient, posted };
}

function fakePrefs(): PreferencesStore & { readonly written: PreferencesPatch[] } {
  const written: PreferencesPatch[] = [];
  let current: Preferences = DEFAULT_PREFERENCES;
  return {
    written,
    read: () => Promise.resolve(current),
    write: (_sub, _segment, patch) => {
      written.push(patch);
      current = { ...current, ...patch };
      return Promise.resolve(current);
    },
  };
}

const identity = {
  session: (cookie: string | undefined) => Promise.resolve(cookie === 'ok' ? session : undefined),
} as unknown as Identity;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(options: { readonly replyPending?: boolean; readonly paged?: boolean } = {}) {
  const { api, posted } = fakeApi({
    replyPending: options.replyPending ?? false,
    paged: options.paged ?? false,
  });
  const prefs = fakePrefs();
  const server = createServer(createM1Handler({ config, identity, api, prefs }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, cookie = 'aw_m1_session=ok') =>
    fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie: 'aw_m1_session=ok', ...headers },
      body,
      redirect: 'manual',
    });
  return { get, post, posted, prefs };
}

const bootstrapOf = (html: string): Bootstrap => {
  const m = /id="aw-bootstrap">(.*?)<\/script>/.exec(html);
  if (m === null) throw new Error('no bootstrap');
  return JSON.parse(m[1]) as Bootstrap;
};

const jsonPost = {
  'content-type': 'application/json',
  'x-csrf-token': CSRF,
  origin: ORIGIN,
};

describe('workspace shell', () => {
  it('redirects the segment root to the startup conversation', async () => {
    const { get } = await serve();
    const response = await get('/s/alpha');
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/s/alpha/teammates/${T}`);
  });

  it('renders the shell with bootstrap for a teammate conversation', async () => {
    const { get } = await serve();
    const response = await get(`/s/alpha/teammates/${T}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html><html lang="en"><head>/);
    const boot = bootstrapOf(html);
    expect(boot.route).toEqual({
      segment: 'alpha',
      teammate: T,
      surface: 'conversation',
      panel: { kind: 'none' },
    });
    expect(boot.scope.memberTag).toMatch(/^[0-9a-f]{16}$/);
    expect(boot.scope).toMatchObject({ segment: 'alpha', csrf: CSRF });
    expect(boot.me.inboxOpen).toBe(3);
    expect(boot.me.model.callsUsed).toBe(7);
    expect(boot.teammates.items[0]).toMatchObject({
      id: T,
      working: true,
      unread: false,
      appearance: { avatar: null, accent: null },
    });
    expect(boot.conversation).toMatchObject({
      segment: 'alpha',
      id: CONV,
      reply: 'none',
      nextCursor: null,
    });
    expect(boot.fallbackHref).toBe(`/s/alpha/pages/teammates/${T}`);
    expect(html).not.toContain(session.sub);
  });

  it('accepts a panel deep link and answers a missing teammate with a 404 shell', async () => {
    const { get } = await serve();
    const details = await get(`/s/alpha/teammates/${T}/details?surface=work`);
    expect(details.status).toBe(200);
    expect(bootstrapOf(await details.text()).route).toMatchObject({
      surface: 'work',
      panel: { kind: 'teammate' },
    });
    const missing = await get(`/s/alpha/teammates/${GONE}`);
    expect(missing.status).toBe(404);
    const boot = bootstrapOf(await missing.text());
    expect(boot.route.panel).toEqual({ kind: 'missing', what: 'teammate', id: GONE });
    expect(boot.conversation).toBeNull();
    expect(boot.teammates.items).toHaveLength(1);
  });

  it('keeps the old page routes as the fallback', async () => {
    const { get } = await serve();
    const page = await get(`/s/alpha/pages/teammates/${T}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Conversation with Haru');
    expect((await get('/s/alpha/inbox')).status).not.toBe(404);
  });

  it('sends a signed-out member to sign-in for HTML and answers 401 JSON for the API', async () => {
    const { get } = await serve();
    const html = await get(`/s/alpha/teammates/${T}`, '');
    expect(html.status).toBe(303);
    expect(html.headers.get('location')).toBe('/sign-in');
    const api = await get('/api/s/alpha/me', '');
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'unauthenticated' });
  });
});

describe('workspace JSON routes', () => {
  it('echoes the segment and uses the paged conversation when the segment serves it', async () => {
    const { get } = await serve({ paged: true });
    const me = await get('/api/s/alpha/me');
    expect(me.headers.get('cache-control')).toBe('no-store');
    expect(await me.json()).toMatchObject({ segment: 'alpha', inboxOpen: 3 });
    const page = await get(`/api/s/alpha/conversations/${CONV}?teammate=${T}&after=abc`);
    expect(await page.json()).toMatchObject({
      segment: 'alpha',
      reply: 'generating',
      nextCursor: 'bmV4dA',
    });
    expect((await get(`/api/s/alpha/conversations/${CONV}?teammate=nope`)).status).toBe(400);
    expect((await get('/api/s/gamma/me')).status).toBe(404);
    expect((await get('/api/s/alpha/nothing')).status).toBe(404);
  });

  it('falls back to the teammate page while the segment cannot page', async () => {
    const { get } = await serve();
    const page = await get(`/api/s/alpha/conversations/${CONV}?teammate=${T}`);
    expect(await page.json()).toMatchObject({
      segment: 'alpha',
      id: CONV,
      reply: 'none',
      nextCursor: null,
    });
  });

  it('gates JSON posts on the csrf header, a JSON content type and the origin', async () => {
    const { post, posted } = await serve();
    const body = JSON.stringify({ clientRequestId: GONE, text: 'hello' });
    const path = `/api/s/alpha/conversations/${CONV}/messages`;
    expect(
      (await post(path, body, { 'content-type': 'application/json', origin: ORIGIN })).status,
    ).toBe(403);
    expect(
      (await post(path, body, { ...jsonPost, 'content-type': 'application/x-www-form-urlencoded' }))
        .status,
    ).toBe(403);
    expect((await post(path, body, { ...jsonPost, origin: 'http://evil.example' })).status).toBe(
      403,
    );
    expect(posted).toHaveLength(0);
    const ok = await post(path, body, jsonPost);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ segment: 'alpha', accepted: true });
    expect(posted).toEqual([
      { conversationId: CONV, body: { clientRequestId: GONE, text: 'hello' } },
    ]);
    expect((await post(path, '{"text":"x"}', jsonPost)).status).toBe(400);
    expect((await post(path, 'not json', jsonPost)).status).toBe(400);
  });

  it('passes a pending reply through as 409', async () => {
    const { post } = await serve({ replyPending: true });
    const response = await post(
      `/api/s/alpha/conversations/${CONV}/messages`,
      JSON.stringify({ clientRequestId: GONE, text: 'again' }),
      jsonPost,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ segment: 'alpha', error: 'reply_pending' });
  });

  it('reads and writes preferences with a closed patch', async () => {
    const { get, post, prefs } = await serve();
    expect(await (await get('/api/s/alpha/preferences')).json()).toEqual({
      segment: 'alpha',
      ...DEFAULT_PREFERENCES,
    });
    const bad = await post('/api/s/alpha/preferences', '{"theme":"dark","token":"x"}', jsonPost);
    expect(bad.status).toBe(400);
    expect(prefs.written).toHaveLength(0);
    const good = await post(
      '/api/s/alpha/preferences',
      JSON.stringify({ theme: 'dark', lastContext: { teammateId: T, tab: 'work' } }),
      jsonPost,
    );
    expect(await good.json()).toMatchObject({
      segment: 'alpha',
      theme: 'dark',
      lastContext: { teammateId: T, tab: 'work' },
    });
    const shell = await get(`/s/alpha/teammates/${T}`);
    expect(await shell.text()).toMatch(/^<!doctype html><html lang="en" data-theme="dark">/);
  });
});
