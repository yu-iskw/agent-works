import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFERENCES } from '../../shared/contract.js';
import { createM1Handler } from '../m1/handler.js';

import type { PreferencesStore } from './preferences.js';
import type { Readiness, SegmentClient } from '../m1/api.js';
import type { WebConfig } from '../m1/config.js';
import type { Identity, Session } from '../m1/identity.js';
import type { TaskDetail } from '@agent-works/domain/teamwork';
import type { AddressInfo } from 'node:net';

const TASK = '22222222-2222-4333-8444-555555555555';
const APPROVAL = '44444444-2222-4333-8444-555555555555';
const FILE = '55555555-2222-4333-8444-555555555555';
const CSRF = 'c'.repeat(64);
const DIGEST = 'd'.repeat(64);
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
  capabilities: [],
  readOnly: false,
  inbox: {},
  sources: {
    repositories: [],
    issue: null,
    pinnedRef: null,
    dataset: null,
    driveConfigured: false,
  },
} as unknown as Readiness;

const detail: TaskDetail = {
  apiVersion: 'teamwork.v1',
  segment: 'alpha',
  task: {
    id: TASK,
    title: 'Flag service',
    workflow: 'research_brief',
    mode: 'coordinated',
    status: 'plan_review',
    version: 4,
    resultOwner: '11111111-2222-4333-8444-555555555555',
    conversationId: null,
    latestRevision: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  },
  scope: { question: 'q', metrics: null, repository: null, issueNumber: null },
  plans: [],
  assignments: [],
  evidence: [],
  revisions: [],
  approvals: [],
  messages: [],
  events: [],
};

type Command = { readonly taskId: string; readonly command: string; readonly body: unknown };

function fakeApi() {
  const commands: Command[] = [];
  const api = {
    segmentFor: (s: Session, id: string) =>
      s.email === session.email ? config.segments.find((seg) => seg.id === id) : undefined,
    me: () => Promise.resolve({ ok: true, value: readiness }),
    teammateRows: () => Promise.resolve({ ok: true, value: { teammates: [] } }),
    task: (_s: Session, _seg: string, id: string) =>
      Promise.resolve(
        id === TASK ? { ok: true, value: detail } : { ok: false, status: 404, error: 'not_found' },
      ),
    attachment: (_s: Session, _seg: string, id: string) =>
      Promise.resolve(
        id === FILE
          ? {
              ok: true,
              value: {
                apiVersion: 'teamwork.v1',
                attachment: {
                  id: FILE,
                  name: 'notes.md',
                  mediaType: 'text/markdown',
                  sizeBytes: 12,
                  sha256: 'e'.repeat(64),
                  createdAt: '2026-10-30T00:00:00.000Z',
                  preview: '# notes',
                  lines: 1,
                  removedAt: null,
                },
                text: '# notes\n',
              },
            }
          : { ok: false, status: 404, error: 'not_found' },
      ),
    command: (_s: Session, _seg: string, taskId: string, command: string, body: unknown) => {
      commands.push({ taskId, command, body });
      return Promise.resolve(
        command === 'plan/decision' && (body as { version: number }).version === 9
          ? { ok: false, status: 409, error: 'stale_plan' }
          : { ok: true, value: { task: detail.task } },
      );
    },
  };
  return { api: api as unknown as SegmentClient, commands };
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

const JSON_HEADERS = {
  origin: ORIGIN,
  'content-type': 'application/json',
  'x-csrf-token': CSRF,
};

async function serve() {
  const { api, commands } = fakeApi();
  const server = createServer(createM1Handler({ config, identity, api, prefs }));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { cookie: 'aw_m1_session=ok' } });
  const post = (path: string, body: string, headers: Record<string, string> = JSON_HEADERS) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie: 'aw_m1_session=ok', ...headers },
      body,
    });
  return { get, post, commands };
}

describe('task detail and attachment routes', () => {
  it('returns the task detail with the segment echo and without the API version', async () => {
    const { get } = await serve();
    const response = await get(`/api/s/alpha/tasks/${TASK}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.segment).toBe('alpha');
    expect(body.apiVersion).toBeUndefined();
    expect((body.task as { version: number }).version).toBe(4);
  });

  it('passes a segment 404 through', async () => {
    const { get } = await serve();
    const response = await get(`/api/s/alpha/tasks/${TASK.replace('2222', '9999')}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ segment: 'alpha', error: 'not_found' });
  });

  it('serves attachment metadata under the segment echo', async () => {
    const { get } = await serve();
    const response = await get(`/api/s/alpha/attachments/${FILE}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { segment: string; attachment: { name: string } };
    expect(body.segment).toBe('alpha');
    expect(body.attachment.name).toBe('notes.md');
    expect(body).not.toHaveProperty('text');
  });
});

describe('task command route', () => {
  it('forwards a valid plan decision with the digest the member presented', async () => {
    const { post, commands } = await serve();
    const body = { version: 2, expectedDigest: DIGEST, decision: 'approve' };
    const response = await post(`/api/s/alpha/tasks/${TASK}/plan/decision`, JSON.stringify(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ segment: 'alpha', task: { id: TASK } });
    expect(commands).toEqual([{ taskId: TASK, command: 'plan/decision', body }]);
  });

  it('refuses a body that fails the command schema before reaching the segment', async () => {
    const { post, commands } = await serve();
    const cases: [string, unknown][] = [
      ['plan/decision', { version: 2, expectedDigest: 'short', decision: 'approve' }],
      ['plan/decision', { version: 2, expectedDigest: DIGEST, decision: 'maybe' }],
      ['action', { approvalId: APPROVAL, decision: 'approve' }],
      ['missing', { decision: 'retry', assignmentIds: ['nope'] }],
      ['publish', { revision: 0 }],
      ['plan/replan', { feedback: '' }],
      ['cancel', { extra: true }],
    ];
    for (const [command, body] of cases) {
      const response = await post(`/api/s/alpha/tasks/${TASK}/${command}`, JSON.stringify(body));
      expect({ command, status: response.status }).toEqual({ command, status: 400 });
    }
    expect(commands).toEqual([]);
  });

  it('accepts bodiless commands with an empty object', async () => {
    const { post, commands } = await serve();
    for (const command of ['cancel', 'retry', 'reconcile']) {
      const response = await post(`/api/s/alpha/tasks/${TASK}/${command}`, '{}');
      expect({ command, status: response.status }).toEqual({ command, status: 200 });
    }
    expect(commands.map((c) => c.command)).toEqual(['cancel', 'retry', 'reconcile']);
  });

  it('does not know commands outside the table', async () => {
    const { post, commands } = await serve();
    const response = await post(`/api/s/alpha/tasks/${TASK}/delete`, '{}');
    expect(response.status).toBe(404);
    expect(commands).toEqual([]);
  });

  it('relays the segment refusal code so the panel can explain a stale plan', async () => {
    const { post } = await serve();
    const response = await post(
      `/api/s/alpha/tasks/${TASK}/plan/decision`,
      JSON.stringify({ version: 9, expectedDigest: DIGEST, decision: 'approve' }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ segment: 'alpha', error: 'stale_plan' });
  });

  it('needs the session CSRF token, a JSON content type and an allowed origin', async () => {
    const { post, commands } = await serve();
    const body = JSON.stringify({ revision: 1 });
    const path = `/api/s/alpha/tasks/${TASK}/publish`;
    const refused = [
      { ...JSON_HEADERS, 'x-csrf-token': 'x'.repeat(64) },
      { ...JSON_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
      { ...JSON_HEADERS, origin: 'http://evil.test' },
      { 'content-type': 'application/json', 'x-csrf-token': CSRF },
    ];
    for (const headers of refused) {
      const response = await post(path, body, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ segment: 'alpha', error: 'csrf' });
    }
    expect(commands).toEqual([]);
  });
});
