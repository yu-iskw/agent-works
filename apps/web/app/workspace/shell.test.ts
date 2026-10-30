import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_ID, DEFAULT_PREFERENCES, MOUNT_ID } from '../../shared/contract.js';

import { memberTag } from './member-tag.js';
import { shellDocument } from './shell.js';
import { resolveStartup } from './startup.js';

import type { Bootstrap, TeammateRow } from '../../shared/contract.js';

const T = '11111111-2222-4333-8444-555555555555';
const T2 = '22222222-2222-4333-8444-555555555555';

const row = (id: string, name: string): TeammateRow => ({
  id,
  name,
  role: 'Research',
  conversationId: '33333333-2222-4333-8444-555555555555',
  appearance: { avatar: null, accent: null },
  lastMessage: null,
  unread: false,
  working: false,
  needsAttention: false,
  unreadResult: false,
  updatedAt: '2026-10-30T00:00:00.000Z',
});

function bootstrap(theme: Bootstrap['prefs']['theme'], text: string): Bootstrap {
  return {
    scope: { memberTag: memberTag('local-test:alice'), segment: 'alpha', csrf: 'c'.repeat(64) },
    route: { segment: 'alpha', teammate: T, surface: 'conversation', panel: { kind: 'none' } },
    me: {
      segment: 'alpha',
      segmentName: 'Alpha',
      segments: [{ id: 'alpha', name: 'Alpha' }],
      member: { email: 'alice@local.test', name: 'alice' },
      identity: 'local-test',
      sourceMode: 'fixture',
      model: { modelId: 'gemini', mode: 'vertex', state: 'ready', callsUsed: 1, callsLimit: 300 },
      readOnly: false,
      inboxOpen: 0,
    },
    prefs: { ...DEFAULT_PREFERENCES, theme },
    teammates: { segment: 'alpha', items: [row(T, 'Haru')], nextCursor: null },
    conversation: {
      segment: 'alpha',
      id: '33333333-2222-4333-8444-555555555555',
      teammateId: T,
      messages: [
        {
          id: '44444444-2222-4333-8444-555555555555',
          role: 'member',
          text,
          taskId: null,
          card: null,
          pending: false,
          at: '2026-10-30T00:00:00.000Z',
        },
      ],
      nextCursor: null,
      prevCursor: null,
      reply: 'none',
      tasks: [],
    },
    notice: null,
    fallbackHref: `/s/alpha/pages/teammates/${T}`,
  };
}

const jsonOf = (html: string): unknown => {
  const m = /<script type="application\/json" id="aw-bootstrap">(.*?)<\/script>/.exec(html);
  return m === null ? undefined : JSON.parse(m[1]);
};

describe('shell document', () => {
  it('sets data-theme only for a manual override', () => {
    expect(
      shellDocument({ bootstrap: bootstrap('system', 'hi'), title: 'Haru', summary: '' }),
    ).toMatch(/^<!doctype html><html lang="en"><head>/);
    expect(
      shellDocument({ bootstrap: bootstrap('dark', 'hi'), title: 'Haru', summary: '' }),
    ).toMatch(/^<!doctype html><html lang="en" data-theme="dark"><head>/);
  });

  it('keeps a hostile message inside the JSON tag and never emits an inline script', () => {
    const text = '</script><script>alert(1)</script><!-- x';
    const html = shellDocument({ bootstrap: bootstrap('light', text), title: 'Haru', summary: '' });
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    expect(scripts).toEqual([
      '<script src="/assets/workspace.js" defer>',
      `<script type="application/json" id="${BOOTSTRAP_ID}">`,
    ]);
    const parsed = jsonOf(html) as Bootstrap;
    expect(parsed.conversation?.messages[0]?.text).toBe(text);
    expect(parsed.scope.memberTag).toMatch(/^[0-9a-f]{16}$/);
  });

  it('renders the mount point with a noscript link to the page version', () => {
    const html = shellDocument({
      bootstrap: bootstrap('system', 'hi'),
      title: 'Haru',
      summary: 'Alpha · alice',
    });
    expect(html).toContain(`<div id="${MOUNT_ID}">`);
    expect(html).toContain(`<noscript><p><a href="/s/alpha/pages/teammates/${T}">`);
    expect(html).toContain('<link rel="stylesheet" href="/assets/workspace.css">');
    expect(html).toContain('<title>Haru · Agent Works</title>');
  });
});

describe('member tag', () => {
  it('is the first 16 hex characters of sha256(sub)', () => {
    expect(memberTag('abc')).toBe('ba7816bf8f01cfea');
    expect(memberTag('abc')).not.toBe(memberTag('abd'));
  });
});

describe('startup resolution', () => {
  const prefs = DEFAULT_PREFERENCES;
  const team = [row(T, 'Haru'), row(T2, 'Mika')];

  it('opens the remembered conversation when it is still accessible', () => {
    expect(
      resolveStartup({ ...prefs, lastContext: { teammateId: T2, tab: 'work' } }, team),
    ).toEqual({ kind: 'teammate', id: T2, notice: null });
  });

  it('falls back to the first teammate with an explanation when the remembered one is gone', () => {
    expect(
      resolveStartup({ ...prefs, lastContext: { teammateId: 'gone', tab: 'teammates' } }, team),
    ).toEqual({ kind: 'teammate', id: T, notice: { code: 'remembered_teammate_gone' } });
    expect(resolveStartup(prefs, team)).toEqual({ kind: 'teammate', id: T, notice: null });
  });

  it('routes the inbox startup to the inbox and no teammates to the empty shell', () => {
    expect(resolveStartup({ ...prefs, startup: 'inbox' }, team)).toEqual({ kind: 'inbox' });
    expect(resolveStartup(prefs, [])).toEqual({ kind: 'empty' });
    expect(resolveStartup({ ...prefs, startup: 'recap' }, team)).toEqual({
      kind: 'teammate',
      id: T,
      notice: null,
    });
  });
});
