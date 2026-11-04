import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { expect, it, vi } from 'vitest';

import { createSegmentClient } from './api.js';
import { createM1Handler } from './handler.js';
import { SESSION_COOKIE, createAssertionSigner } from './identity.js';

import type { WebConfig } from './config.js';
import type { Identity, Session } from './identity.js';
import type { PreferencesStore } from '../workspace/preferences.js';

const id = '11f91fcf-8795-4808-9b9c-5f9e7c3dcd76';
const digest = 'a'.repeat(64);
const session: Session = {
  sub: 'alice',
  email: 'alice@local.test',
  name: 'Alice',
  idp: 'local-test',
  csrf: 'csrf-token',
  expiresAt: new Date('2099-01-01'),
};
const config: WebConfig = {
  publicUrl: 'http://localhost:8080',
  identity: 'local-test',
  segments: [{ id: 'alpha', name: 'Alpha', url: 'http://alpha.test' }],
  databaseUrl: '',
  keyDir: '',
  google: undefined,
  members: new Map([['alpha', new Set([session.email])]]),
  e2eSecret: undefined,
  missing: [],
};
const identity: Identity = {
  redirectUri: '',
  session: () => Promise.resolve(session),
  signOut: () => Promise.resolve(),
  startGoogle: () => Promise.reject(new Error('unused')),
  completeGoogle: () => Promise.reject(new Error('unused')),
  localTest: () => Promise.reject(new Error('unused')),
  e2eAuthorize: () => Promise.reject(new Error('unused')),
  e2eSession: () => Promise.reject(new Error('unused')),
};
const prefs: PreferencesStore = {
  read: () => Promise.reject(new Error('unused')),
  write: () => Promise.reject(new Error('unused')),
};

it('forwards the reviewed revision and digest and explains stale confirmation', async () => {
  let submitted: unknown;
  const api = createSegmentClient(config, createAssertionSigner('local-test'), (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    let status = 200;
    let body: object = {};
    if (url.pathname.endsWith('/publish')) {
      submitted = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      status = 409;
      body = { error: 'stale_confirmation' };
    } else if (
      url.pathname.endsWith('/preview') ||
      url.pathname.endsWith('/active') ||
      url.pathname.endsWith('/me')
    ) {
      status = 404;
      body = { error: 'not_found' };
    } else if (url.pathname.endsWith('/runs')) body = { runs: [] };
    else if (url.pathname.endsWith(`/teammates/${id}`))
      body = { teammate: { name: 'Coordinator' }, conversation: { messages: [] } };
    else {
      status = 404;
      body = { error: 'not_found' };
    }
    return Promise.resolve(
      new Response(JSON.stringify(status === 200 ? { apiVersion: 'teamwork.v1', ...body } : body), {
        status,
      }),
    );
  });
  const handler = createM1Handler({ config, identity, api, prefs });
  const req = new IncomingMessage(new Socket());
  req.method = 'POST';
  req.url = `/s/alpha/bots/${id}/publish`;
  req.headers = {
    cookie: `${SESSION_COOKIE}=ok`,
    origin: 'http://localhost:8080',
    'content-type': 'application/x-www-form-urlencoded',
  };
  req.push(new URLSearchParams({ csrf: session.csrf, revision: '3', digest }).toString());
  req.push(null);
  const response = Object.assign(new ServerResponse(req), { req });
  const output = await new Promise<{ status: number; html: string }>((resolve) => {
    let status = 0;
    vi.spyOn(response, 'writeHead').mockImplementation((code) => {
      status = code;
      return response;
    });
    vi.spyOn(response, 'end').mockImplementation((chunk: unknown) => {
      resolve({ status, html: String(chunk) });
      return response;
    });
    handler(req, response);
  });
  expect(submitted).toEqual({ revision: 3, digest });
  expect(output.status).toBe(409);
  expect(output.html).toContain('This draft changed since you reviewed it');
});
