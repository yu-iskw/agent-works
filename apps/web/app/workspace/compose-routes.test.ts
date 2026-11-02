import { createServer } from 'node:http';

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_NAME_MAX,
} from '@agent-works/domain/teamwork';
import { afterEach, describe, expect, it } from 'vitest';

import { FILE_MAX_BYTES, FILE_MAX_PER_MESSAGE, FILE_NAME_MAX } from '../../shared/composer.js';
import { DEFAULT_PREFERENCES } from '../../shared/contract.js';
import { createM1Handler } from '../m1/handler.js';

import { menuSources, targetOf } from './compose-routes.js';

import type { PreferencesStore } from './preferences.js';
import type { Readiness, SegmentClient } from '../m1/api.js';
import type { WebConfig } from '../m1/config.js';
import type { Identity, Session } from '../m1/identity.js';
import type { TaskDetail, TeammateView } from '@agent-works/domain/teamwork';
import type { AddressInfo } from 'node:net';

const T = '11111111-2222-4333-8444-555555555555';
const CONV = '33333333-2222-4333-8444-555555555555';
const OTHER_CONV = '66666666-2222-4333-8444-555555555555';
const TASK = '22222222-2222-4333-8444-555555555555';
const FILE = '55555555-2222-4333-8444-555555555555';
const REQ = '77777777-2222-4333-8444-555555555555';
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

const readiness = {
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
  capabilities: ['drive.read', 'github.read'],
  readOnly: false,
  inbox: {},
  sources: {
    repositories: ['acme/widgets'],
    issue: 12,
    pinnedRef: null,
    dataset: null,
    driveConfigured: false,
  },
} as unknown as Readiness;

const teammate: TeammateView = {
  id: T,
  name: 'Haru',
  role: 'Research',
  instructions: '',
  template: { id: T, version: 1, name: 'Researcher' },
  skills: [{ id: FILE, version: 1, name: 'Research brief' }],
  capabilities: [
    {
      capability: 'drive.read',
      requested: true,
      permitted: true,
      connected: true,
      effective: true,
      reason: null,
    },
  ],
  version: 1,
  origin: 'template',
  conversationId: CONV,
  appearance: { avatar: 'leaf', accent: 'mint' },
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
};

const detail: TaskDetail = {
  apiVersion: 'teamwork.v1',
  segment: 'alpha',
  task: {
    id: TASK,
    title: 'Tool comparison',
    workflow: 'research_brief',
    mode: 'manual',
    status: 'needs_input',
    version: 3,
    resultOwner: T,
    conversationId: CONV,
    latestRevision: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  },
  scope: { question: 'Compare tools', metrics: null, repository: null, issueNumber: null },
  plans: [],
  assignments: [
    {
      id: FILE,
      key: 'research',
      teammateId: T,
      teammateName: 'Haru',
      skills: [],
      brief: 'b',
      deliverable: 'd',
      sources: ['drive_research'],
      status: 'needs_input',
      attempt: 1,
      planVersion: null,
      question: 'Which region?',
      errorCode: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      deadlineAt: '2026-10-30T01:00:00.000Z',
      output: null,
      model: null,
    },
  ],
  evidence: [],
  revisions: [],
  approvals: [],
  messages: [],
  events: [],
};

type Call = { readonly method: string; readonly body: unknown };

function fakeApi() {
  const calls: Call[] = [];
  const api = {
    segmentFor: (s: Session, id: string) =>
      s.email === session.email ? config.segments.find((seg) => seg.id === id) : undefined,
    me: () => Promise.resolve({ ok: true, value: readiness }),
    teammates: () => Promise.resolve({ ok: true, value: { teammates: [teammate] } }),
    teammateRows: () => Promise.resolve({ ok: true, value: { teammates: [teammate] } }),
    catalog: () =>
      Promise.resolve({
        ok: true,
        value: {
          templates: [],
          skills: [
            {
              id: FILE,
              version: 1,
              origin: 'curated',
              derivedFrom: null,
              ownerSub: null,
              definition: {
                name: 'Research brief',
                summary: 'Compare sources',
                workflows: ['research_brief'],
                outputSections: ['Alternatives', 'Conclusion'],
              },
              createdAt: '2026-10-30T00:00:00.000Z',
              attachedTo: [T],
            },
          ],
        },
      }),
    task: (_s: Session, _seg: string, id: string) =>
      Promise.resolve(
        id === TASK ? { ok: true, value: detail } : { ok: false, status: 404, error: 'not_found' },
      ),
    uploadAttachment: (_s: Session, _seg: string, _c: string, body: unknown) => {
      calls.push({ method: 'uploadAttachment', body });
      if ((body as { name: string }).name === 'bad.csv')
        return Promise.resolve({
          ok: false,
          status: 400,
          error: 'attachment_invalid_csv',
          detail: 'Row 3 has 4 columns; the header has 3.',
        });
      return Promise.resolve({
        ok: true,
        value: {
          attachment: {
            id: FILE,
            name: 'notes.md',
            mediaType: 'text/markdown',
            sizeBytes: 5,
            sha256: 'a'.repeat(64),
            createdAt: '2026-10-30T00:00:00.000Z',
            preview: 'hello',
            lines: 1,
            removedAt: null,
          },
        },
      });
    },
    removeAttachment: (_s: Session, _seg: string, id: string) => {
      calls.push({ method: 'removeAttachment', body: id });
      return Promise.resolve({ ok: true, value: { removed: true } });
    },
    createTask: (_s: Session, _seg: string, body: unknown) => {
      calls.push({ method: 'createTask', body });
      return Promise.resolve({
        ok: false as const,
        status: 400,
        error: 'source_unavailable_for_teammate',
      });
    },
    inbox: () => Promise.resolve({ ok: true, value: { items: [] } }),
  };
  return { api: api as unknown as SegmentClient, calls };
}

const prefs: PreferencesStore = {
  read: () => Promise.resolve(DEFAULT_PREFERENCES),
  write: () => Promise.resolve(DEFAULT_PREFERENCES),
};

const identity = {
  session: (cookie: string | undefined) => Promise.resolve(cookie === 'ok' ? session : undefined),
} as unknown as Identity;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve() {
  const { api, calls } = fakeApi();
  const server = createServer(createM1Handler({ config, identity, api, prefs }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { cookie: 'aw_m1_session=ok' } });
  const post = (path: string, body: unknown, headers: Record<string, string> = jsonPost) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie: 'aw_m1_session=ok', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { get, post, calls };
}

const jsonPost = { 'content-type': 'application/json', 'x-csrf-token': CSRF, origin: ORIGIN };

describe('shared file limits', () => {
  it('match the domain constants the segment enforces', () => {
    expect(FILE_MAX_BYTES).toBe(ATTACHMENT_MAX_BYTES);
    expect(FILE_MAX_PER_MESSAGE).toBe(ATTACHMENT_MAX_PER_MESSAGE);
    expect(FILE_NAME_MAX).toBe(ATTACHMENT_NAME_MAX);
  });
});

describe('GET /composer', () => {
  it('assembles teammates with capabilities, attached skills and source availability', async () => {
    const { get } = await serve();
    const response = await get('/api/s/alpha/composer');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      segment: string;
      teammates: { id: string; templateName: string; capabilities: unknown[] }[];
      skills: { id: string; attachedTo: string[]; synthesizes: boolean }[];
      sources: { kind: string; unavailable: string | null }[];
      repositories: string[];
    };
    expect(body.segment).toBe('alpha');
    expect(body.teammates[0]).toMatchObject({ id: T, templateName: 'Researcher' });
    expect(body.teammates[0].capabilities).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({ id: FILE, attachedTo: [T], synthesizes: true });
    const byKind = Object.fromEntries(body.sources.map((s) => [s.kind, s.unavailable]));
    expect(byKind).toEqual({
      drive_research: null,
      drive_context: null,
      bigquery_metrics: 'Needs BigQuery — not available in this segment',
      github_issue: null,
      github_code: null,
      member_file: null,
    });
    expect(body.repositories).toEqual(['acme/widgets']);
  });

  it('marks a source unavailable before its connection state', () => {
    const sources = menuSources({ ...readiness, capabilities: [] });
    expect(sources.find((s) => s.kind === 'github_issue')?.unavailable).toBe(
      'Needs GitHub — not available in this segment',
    );
  });

  it('needs the live folder, dataset and allowlist only outside fixture mode', () => {
    const live = menuSources({
      ...readiness,
      sourceMode: 'live',
      capabilities: ['drive.read', 'bigquery.query', 'github.read'],
      sources: { ...readiness.sources, repositories: [] },
    });
    const byKind = Object.fromEntries(live.map((s) => [s.kind, s.unavailable]));
    expect(byKind).toMatchObject({
      drive_research: 'Needs Google Drive — not configured in this segment',
      bigquery_metrics: 'Needs BigQuery — no dataset configured in this segment',
      github_code: 'Needs GitHub — no repository allowlisted in this segment',
    });
    const fixture = menuSources({
      ...readiness,
      capabilities: ['drive.read', 'bigquery.query', 'github.read'],
      sources: { ...readiness.sources, repositories: [] },
    });
    expect(fixture.every((s) => s.unavailable === null)).toBe(true);
  });
});

describe('GET /conversations/:id/targets', () => {
  it('returns open questions and the latest revision for tasks of that conversation only', async () => {
    const { get } = await serve();
    const response = await get(`/api/s/alpha/conversations/${CONV}/targets?tasks=${TASK},${FILE}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      segment: 'alpha',
      tasks: [
        {
          taskId: TASK,
          title: 'Tool comparison',
          status: 'needs_input',
          version: 3,
          latestRevision: 1,
          openQuestions: [{ assignmentId: FILE, teammateName: 'Haru', question: 'Which region?' }],
        },
      ],
    });
    const elsewhere = await get(`/api/s/alpha/conversations/${OTHER_CONV}/targets?tasks=${TASK}`);
    expect(await elsewhere.json()).toEqual({ segment: 'alpha', tasks: [] });
    expect((await get(`/api/s/alpha/conversations/${CONV}/targets?tasks=nope`)).status).toBe(400);
  });

  it('derives a target from a detail without touching answered questions', () => {
    const answered = {
      ...detail,
      assignments: [{ ...detail.assignments[0], status: 'running' as const }],
    };
    expect(targetOf(answered).openQuestions).toEqual([]);
  });
});

describe('POST /conversations/:id/attachments', () => {
  it('forwards a valid text file and echoes the stored attachment', async () => {
    const { post, calls } = await serve();
    const response = await post(`/api/s/alpha/conversations/${CONV}/attachments`, {
      name: 'notes.md',
      mediaType: 'text/markdown',
      text: 'hello',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      segment: 'alpha',
      attachment: { id: FILE, preview: 'hello' },
    });
    expect(calls).toEqual([
      {
        method: 'uploadAttachment',
        body: { name: 'notes.md', mediaType: 'text/markdown', text: 'hello' },
      },
    ]);
  });

  it('accepts a media type with parameters and passes the segment explanation back', async () => {
    const { post, calls } = await serve();
    const path = `/api/s/alpha/conversations/${CONV}/attachments`;
    const csv = await post(path, {
      name: 'data.csv',
      mediaType: 'text/CSV; charset=utf-8',
      text: 'a,b\n1,2',
    });
    expect(csv.status).toBe(201);
    expect(calls.at(-1)).toMatchObject({ body: { mediaType: 'text/csv' } });
    const bad = await post(path, { name: 'bad.csv', mediaType: 'text/csv', text: 'a,b\n1,2,3' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      segment: 'alpha',
      error: 'attachment_invalid_csv',
      detail: 'Row 3 has 4 columns; the header has 3.',
    });
  });

  it('refuses unsupported types, empty and oversize text with a named code, before the segment', async () => {
    const { post, calls } = await serve();
    const path = `/api/s/alpha/conversations/${CONV}/attachments`;
    const pdf = await post(path, { name: 'r.pdf', mediaType: 'application/pdf', text: 'x' });
    expect(pdf.status).toBe(400);
    expect(await pdf.json()).toEqual({ segment: 'alpha', error: 'unsupported_media_type' });
    const empty = await post(path, { name: 'a.txt', mediaType: 'text/plain', text: '  \n' });
    expect(await empty.json()).toEqual({ segment: 'alpha', error: 'attachment_empty' });
    const big = await post(path, {
      name: 'a.txt',
      mediaType: 'text/plain',
      text: '日'.repeat(70_000),
    });
    expect(await big.json()).toEqual({ segment: 'alpha', error: 'attachment_too_large' });
    const extra = await post(path, { name: 'a.txt', mediaType: 'text/plain', text: 'x', evil: 1 });
    expect(extra.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('accepts a body above the default JSON limit but not above the upload limit', async () => {
    const { post } = await serve();
    const path = `/api/s/alpha/conversations/${CONV}/attachments`;
    const ok = await post(path, {
      name: 'a.txt',
      mediaType: 'text/plain',
      text: 'a'.repeat(200_000),
    });
    expect(ok.status).toBe(201);
    const huge = await post(path, {
      name: 'a.txt',
      mediaType: 'text/plain',
      text: 'a'.repeat(900_000),
    });
    expect(huge.status).toBe(413);
  });

  it('requires the CSRF header and a same-origin JSON request', async () => {
    const { post, calls } = await serve();
    const path = `/api/s/alpha/conversations/${CONV}/attachments`;
    const body = { name: 'a.txt', mediaType: 'text/plain', text: 'x' };
    expect(
      (await post(path, body, { 'content-type': 'application/json', origin: ORIGIN })).status,
    ).toBe(403);
    expect((await post(path, body, { ...jsonPost, 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await post(path, body, { ...jsonPost, origin: 'http://evil.test' })).status).toBe(403);
    expect(
      (
        await post(path, 'name=a', {
          'content-type': 'application/x-www-form-urlencoded',
          'x-csrf-token': CSRF,
          origin: ORIGIN,
        })
      ).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe('POST /attachments/:id/remove and POST /tasks', () => {
  it('forwards a removal', async () => {
    const { post, calls } = await serve();
    const response = await post(`/api/s/alpha/attachments/${FILE}/remove`, {});
    expect(await response.json()).toEqual({ segment: 'alpha', removed: true });
    expect(calls).toEqual([{ method: 'removeAttachment', body: FILE }]);
  });

  it('parses the task body with the domain schema and passes segment refusals through', async () => {
    const { post, calls } = await serve();
    const body = {
      clientRequestId: REQ,
      workflow: 'research_brief',
      mode: 'manual',
      scope: {
        question: 'Compare tools',
        metrics: null,
        repository: null,
        issueNumber: null,
        attachmentIds: [FILE],
      },
      resultOwner: T,
      conversationId: CONV,
      assignments: [
        { teammateId: T, brief: 'Compare tools', sources: ['drive_research', 'member_file'] },
      ],
    };
    const refused = await post('/api/s/alpha/tasks', body);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      segment: 'alpha',
      error: 'source_unavailable_for_teammate',
    });
    expect(calls).toEqual([{ method: 'createTask', body }]);
    const bad = await post('/api/s/alpha/tasks', { ...body, workflow: 'research' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ segment: 'alpha', error: 'bad_request' });
    expect(calls).toHaveLength(1);
  });
});
