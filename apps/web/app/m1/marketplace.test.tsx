import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createSegmentClient } from './api.js';
import { createM1Handler } from './handler.js';
import { SESSION_COOKIE, createAssertionSigner } from './identity.js';

import type { Connection } from './api.js';
import type { WebConfig } from './config.js';
import type { Identity, Session } from './identity.js';
import type { PreferencesStore } from '../workspace/preferences.js';
import type { MarketplaceKind, MarketplaceListing } from '@agent-works/domain/marketplace';
import type { OutgoingHttpHeaders } from 'node:http';

const ORIGIN = 'http://localhost:8080';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const SESSION: Session = {
  sub: 'local-test:alice',
  email: 'alice@local.test',
  name: 'alice',
  idp: 'local-test',
  csrf: 'c'.repeat(64),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
};

const CONFIG: WebConfig = {
  publicUrl: ORIGIN,
  identity: 'local-test',
  segments: [{ id: 'alpha', name: 'Alpha', url: 'http://alpha.test' }],
  databaseUrl: '',
  keyDir: '',
  google: undefined,
  members: new Map([['alpha', new Set(['alice@local.test'])]]),
  e2eSecret: undefined,
  missing: [],
};

const IDENTITY: Identity = {
  redirectUri: `${ORIGIN}/auth/google/callback`,
  session: (cookie) => Promise.resolve(cookie === 'ok' ? SESSION : undefined),
  signOut: () => Promise.resolve(),
  startGoogle: () => Promise.reject(new Error('unused')),
  completeGoogle: () => Promise.reject(new Error('unused')),
  localTest: () => Promise.reject(new Error('unused')),
  e2eAuthorize: () => Promise.reject(new Error('unused')),
  e2eSession: () => Promise.reject(new Error('unused')),
};

const PREFS: PreferencesStore = {
  read: () => Promise.reject(new Error('unused')),
  write: () => Promise.reject(new Error('unused')),
};

const listing = (
  kind: MarketplaceKind,
  id: string,
  name: string,
  status: MarketplaceListing['status'],
  extra: Partial<MarketplaceListing> = {},
): MarketplaceListing => ({
  kind,
  id,
  version: '1.0.0',
  name,
  summary: `${name} summary`,
  publisher: 'agent-works',
  status,
  ...extra,
});

const GOOGLE = listing('connector', 'google', 'Google', 'enabled');
const GITHUB = listing('connector', 'github', 'GitHub', 'disabled');

const installation = (
  connector: string,
  desiredState: 'enabled' | 'disabled',
  generation: number,
) => ({
  connector,
  version: '1.0.0',
  previousVersion: null,
  capabilities: connector === 'google' ? ['drive.read'] : ['github.read'],
  desiredState,
  observedState: 'not_required',
  observedDetail: null,
  generation,
  updatedAt: '2026-11-02T00:00:00.000Z',
});

const googleDetail = (overrides: Record<string, unknown> = {}) => ({
  kind: 'connector',
  listing: GOOGLE,
  capabilities: [
    {
      id: 'drive.read',
      access: 'read',
      tools: ['drive_read'],
      requiredScopes: [DRIVE_SCOPE],
      allowedByEnv: true,
      enabled: true,
    },
    {
      id: 'docs.publish',
      access: 'write',
      tools: ['docs_publish'],
      requiredScopes: [],
      allowedByEnv: true,
      enabled: false,
    },
    {
      id: 'bigquery.query',
      access: 'read',
      tools: ['bigquery_query'],
      requiredScopes: [],
      allowedByEnv: false,
      enabled: false,
    },
  ],
  installation: installation('google', 'enabled', 3),
  ...overrides,
});

const githubDetail = (overrides: Record<string, unknown> = {}) => ({
  kind: 'connector',
  listing: GITHUB,
  capabilities: [
    {
      id: 'github.read',
      access: 'read',
      tools: ['github_read'],
      requiredScopes: [],
      allowedByEnv: true,
      enabled: false,
    },
  ],
  installation: installation('github', 'disabled', 2),
  ...overrides,
});

const connection = (
  provider: Connection['provider'],
  overrides: Partial<Connection> = {},
): Connection => ({
  provider,
  status: 'active',
  account: 'alice@local.test',
  scopes: [DRIVE_SCOPE],
  connectedAt: '2026-11-01T00:00:00.000Z',
  errorCode: null,
  configured: true,
  ...overrides,
});

type Backend = {
  admin: boolean;
  listings: Partial<Record<MarketplaceKind, readonly MarketplaceListing[]>>;
  details: Record<string, unknown>;
  connections: readonly Connection[] | 'down';
  listFails: number | undefined;
  mutate: { status: number; body: unknown };
};

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    admin: false,
    listings: {
      connector: [GOOGLE, GITHUB],
      team_bot: [
        listing('team_bot', 'research-analyst', 'Research analyst', 'available', {
          href: '/catalog',
        }),
      ],
      mcp_server: [listing('mcp_server', 'mcp-servers', 'MCP servers', 'coming_soon')],
      a2a_agent: [listing('a2a_agent', 'a2a-agents', 'A2A agents', 'coming_soon')],
    },
    details: { google: googleDetail(), github: githubDetail() },
    connections: [connection('google'), connection('github', { scopes: [] })],
    listFails: undefined,
    mutate: { status: 200, body: { installation: installation('google', 'disabled', 4) } },
    ...overrides,
  };
}

type Call = { readonly method: string; readonly path: string; readonly body: unknown };

/** Record lookup by a runtime key without index access, which the security lint rejects. */
const lookup = <T,>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.entries(record).find(([name]) => name === key)?.[1];

const reply = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(
      JSON.stringify(status < 300 ? { apiVersion: 'teamwork.v1', ...(body as object) } : body),
      { status, headers: { 'content-type': 'application/json' } },
    ),
  );

type Reply = {
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly html: string;
};

type Site = {
  readonly calls: Call[];
  get(path: string): Promise<Reply>;
  post(path: string, form: URLSearchParams): Promise<Reply>;
};

/** What the segment backend answers for one request. */
function answer(state: Backend, method: string, url: URL): Promise<Response> {
  const path = url.pathname.replace('/v1/teamwork', '');
  const notFound = reply(404, { error: 'not_found' });
  if (method === 'POST') return reply(state.mutate.status, state.mutate.body);
  if (path === '/marketplace')
    return state.listFails === undefined
      ? reply(200, {
          listings: lookup(state.listings, url.searchParams.get('kind') ?? '') ?? [],
          admin: state.admin,
        })
      : reply(state.listFails, { error: 'unavailable' });
  if (path === '/connections')
    return state.connections === 'down'
      ? reply(503, { error: 'unavailable' })
      : reply(200, { connections: state.connections });
  const detail = /^\/marketplace\/connector\/(.+)$/.exec(path)?.[1];
  const item = detail === undefined ? undefined : lookup(state.details, detail);
  return item === undefined ? notFound : reply(200, { item });
}

function site(state: Backend): Site {
  const calls: Call[] = [];
  const api = createSegmentClient(CONFIG, createAssertionSigner('local-test'), (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: `${url.pathname.replace('/v1/teamwork', '')}${url.search}`, body });
    return answer(state, method, url);
  });
  const handler = createM1Handler({ config: CONFIG, identity: IDENTITY, api, prefs: PREFS });

  function invoke(method: string, path: string, form?: URLSearchParams): Promise<Reply> {
    const request = new IncomingMessage(new Socket());
    request.method = method;
    request.url = path;
    request.headers = {
      cookie: `${SESSION_COOKIE}=ok`,
      ...(form === undefined
        ? {}
        : { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }),
    };
    request.push(form?.toString() ?? '');
    request.push(null);
    // The handler writes with writeHead and end; capturing them keeps the suite free of sockets.
    return new Promise((resolve) => {
      const response = Object.assign(new ServerResponse(request), { req: request });
      let status = 0;
      let headers: OutgoingHttpHeaders = {};
      vi.spyOn(response, 'writeHead').mockImplementation((code, values) => {
        status = code;
        headers = Array.isArray(values) ? {} : (values ?? {});
        return response;
      });
      vi.spyOn(response, 'end').mockImplementation((chunk: unknown) => {
        // Vitest's dev JSX transform stamps every element with a source object the production build lacks.
        const html =
          typeof chunk === 'string' ? chunk.replaceAll(' __source="[object Object]"', '') : '';
        resolve({ status, headers, html });
        return response;
      });
      handler(request, response);
    });
  }

  return {
    calls,
    get: (path) => invoke('GET', path),
    post: (path, form) => invoke('POST', path, form),
  };
}

async function page(
  state: Backend,
  path = '/s/alpha/marketplace',
): Promise<{ html: string; status: number; calls: Call[] }> {
  const app = site(state);
  const { html, status } = await app.get(path);
  return { html, status, calls: app.calls };
}

async function post(
  state: Backend,
  action: string,
  form: Record<string, string | string[]>,
  csrf = SESSION.csrf,
): Promise<{ response: Reply; calls: Call[]; follow: () => Promise<string> }> {
  const app = site(state);
  const body = new URLSearchParams({ csrf });
  for (const [key, value] of Object.entries(form))
    for (const each of [value].flat()) body.append(key, each);
  const response = await app.post(`/s/alpha/marketplace/connectors/google/${action}`, body);
  return {
    response,
    calls: app.calls,
    follow: async () => (await app.get(String(response.headers.location))).html,
  };
}

/** The markup of the one article whose heading is `name`. */
function articleOf(html: string, name: string): string {
  const articles = html.split('<article').slice(1);
  const found = articles.find((article) => article.includes(`>${name}</h3>`));
  if (found === undefined) throw new Error(`no listing named ${name}`);
  return found.split('</article>')[0] ?? '';
}

describe('marketplace tabs', () => {
  it('offers one link per kind and marks the current one', async () => {
    const { html } = await page(backend(), '/s/alpha/marketplace?kind=team_bot');
    const nav = /<nav aria-label="Marketplace kinds">(.*?)<\/nav>/s.exec(html)?.[1] ?? '';
    for (const [kind, label] of [
      ['connector', 'Connectors'],
      ['team_bot', 'Team bots'],
      ['mcp_server', 'MCP servers'],
      ['a2a_agent', 'A2A agents'],
    ]) {
      expect(nav).toContain(`href="/s/alpha/marketplace?kind=${kind}"`);
      expect(nav).toContain(`>${label}</a>`);
    }
    expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
    expect(/aria-current="page"[^>]*>Team bots</.test(nav)).toBe(true);
  });

  it('asks the segment for the chosen kind only, and falls back to connectors on a bad kind', async () => {
    const team = await page(backend(), '/s/alpha/marketplace?kind=team_bot');
    expect(team.calls.map((call) => call.path)).toEqual(['/me', '/marketplace?kind=team_bot']);
    const bad = await page(backend(), '/s/alpha/marketplace?kind=nonsense');
    expect(bad.status).toBe(200);
    expect(bad.calls.map((call) => call.path)).toContain('/marketplace?kind=connector');
    expect(bad.html).toContain('>Google</h3>');
  });

  it('is reachable from the main navigation', async () => {
    const { html } = await page(backend());
    expect(html).toMatch(/href="\/s\/alpha\/marketplace"[^>]*aria-current="page"/);
  });
});

describe('honest states', () => {
  it('tells enabled, disabled, available and coming soon apart', async () => {
    const connectors = await page(
      backend({
        listings: {
          connector: [GOOGLE, GITHUB, listing('connector', 'extra', 'Extra', 'available')],
        },
        details: {
          google: googleDetail(),
          github: githubDetail(),
          extra: {
            kind: 'connector',
            listing: listing('connector', 'extra', 'Extra', 'available'),
            capabilities: [],
            installation: null,
          },
        },
      }),
    );
    expect(articleOf(connectors.html, 'Google')).toContain('>Enabled<');
    expect(articleOf(connectors.html, 'GitHub')).toContain('>Disabled<');
    const extra = articleOf(connectors.html, 'Extra');
    expect(extra).toContain('>Available<');
    expect(extra).toContain('cannot be enabled here');
    const soon = await page(backend(), '/s/alpha/marketplace?kind=mcp_server');
    const mcp = articleOf(soon.html, 'MCP servers');
    expect(mcp).toContain('>Coming soon<');
    expect(mcp).not.toMatch(/<form|<button|<input/);
    expect(
      articleOf((await page(backend(), '/s/alpha/marketplace?kind=a2a_agent')).html, 'A2A agents'),
    ).toContain('>Coming soon<');
  });

  it('shows read and write, allowed and on per capability', async () => {
    const { html } = await page(backend());
    const google = articleOf(html, 'Google');
    expect(google).toContain('aria-label="Capabilities of Google"');
    expect(google).toMatch(
      /<span class="chip">Read<\/span>\s*<span><strong>Read Drive<\/strong> <span class="badge badge-ok">On</,
    );
    expect(google).toMatch(
      /<span class="chip">Write<\/span>\s*<span><strong>Create Google Docs \(with approval\)<\/strong> <span class="badge badge-neutral">Off</,
    );
    expect(google).toContain('Not allowed in this segment');
  });

  it.each([
    [
      'configured but not connected',
      [
        connection('google', {
          status: 'not_connected',
          account: null,
          scopes: [],
          connectedAt: null,
        }),
      ],
      'Configured, not connected',
      'badge-neutral',
    ],
    ['connected', [connection('google')], 'Connected', 'badge-ok'],
    [
      'permission needed (missing scope)',
      [connection('google', { scopes: [] })],
      'Permission needed: drive.readonly',
      'badge-bad',
    ],
    [
      'permission needed (scopes_missing)',
      [connection('google', { status: 'error', errorCode: 'scopes_missing' })],
      'Permission needed',
      'badge-bad',
    ],
    [
      'revoked',
      [connection('google', { status: 'revoked', errorCode: 'revoked' })],
      'Needs attention (revoked)',
      'badge-bad',
    ],
    [
      'provider not configured',
      [connection('google', { status: 'not_connected', configured: false })],
      'Provider not configured',
      'badge-test',
    ],
  ])('shows %s as its own state', async (_name, connections, label, tone) => {
    const { html } = await page(backend({ connections }));
    expect(articleOf(html, 'Google')).toContain(`<span class="badge ${tone}">${label}</span>`);
  });

  it('keeps the page and marks the connection unknown when connections cannot be read', async () => {
    const { html, status } = await page(backend({ connections: 'down' }));
    expect(status).toBe(200);
    expect(html).toContain('Your connection status could not be read');
    expect(articleOf(html, 'Google')).toContain('Connection unknown');
  });

  it('links team bots to the existing template flow and offers no switch', async () => {
    const { html } = await page(backend(), '/s/alpha/marketplace?kind=team_bot');
    const bot = articleOf(html, 'Research analyst');
    expect(bot).toContain('href="/s/alpha/catalog"');
    expect(bot).toContain('>Available<');
    expect(bot).not.toMatch(/<form|<button/);
  });
});

describe('admin controls', () => {
  it('render nothing for a member who is not an admin', async () => {
    const { html } = await page(backend({ admin: false }));
    expect(html).toContain('Only segment admins can enable or disable connectors.');
    expect(html).not.toContain('expectedGeneration');
    expect(html).not.toContain('/marketplace/connectors/');
  });

  it('render enable and disable forms with CSRF and the loaded generation for an admin', async () => {
    const { html } = await page(backend({ admin: true }));
    const google = articleOf(html, 'Google');
    expect(google).toContain('action="/s/alpha/marketplace/connectors/google/disable"');
    expect(google).toContain('Disable Google');
    expect(google).toContain('name="expectedGeneration" value="3"');
    expect(google).toContain(`name="csrf" value="${SESSION.csrf}"`);
    expect(articleOf(html, 'GitHub')).toContain(
      'action="/s/alpha/marketplace/connectors/github/enable"',
    );
    expect(articleOf(html, 'GitHub')).toContain('name="expectedGeneration" value="2"');
    expect(articleOf(html, 'GitHub')).not.toContain('Capabilities for');
  });

  it('lets an admin pick capabilities one by one and cannot tick what the segment forbids', async () => {
    const google = articleOf((await page(backend({ admin: true }))).html, 'Google');
    expect(google).toContain('<legend>Capabilities for Google</legend>');
    expect(google).toMatch(/name="capability" value="drive.read" checked>/);
    expect(google).toMatch(/name="capability" value="docs.publish">/);
    expect(google).toMatch(/name="capability" value="bigquery.query" disabled>/);
  });

  it('marks every action as a once-only submit with a spinner for the pending state', async () => {
    const google = articleOf((await page(backend({ admin: true }))).html, 'Google');
    const buttons = google.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toContain('data-submit="once"');
    expect(google.match(/<span class="spinner" aria-hidden="true">/g)).toHaveLength(2);
  });

  it('keeps the connector without a row free of controls', async () => {
    const state = backend({
      admin: true,
      listings: { connector: [listing('connector', 'extra', 'Extra', 'available')] },
      details: {
        extra: {
          kind: 'connector',
          listing: listing('connector', 'extra', 'Extra', 'available'),
          capabilities: [],
          installation: null,
        },
      },
    });
    expect(articleOf((await page(state)).html, 'Extra')).not.toMatch(/<form|<button/);
  });
});

describe('admin actions', () => {
  it('forward the generation the form carries, and nothing that names a segment or actor', async () => {
    const { response, calls } = await post(backend({ admin: true }), 'disable', {
      expectedGeneration: '3',
      segment: 'beta',
      actor: 'mallory@example.test',
    });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(
      '/s/alpha/marketplace?kind=connector&notice=connector_disabled',
    );
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/marketplace/connectors/google',
        body: { action: 'disable', expectedGeneration: 3 },
      },
    ]);
  });

  it('send the ticked capabilities for a save', async () => {
    const { calls } = await post(backend({ admin: true }), 'set_capabilities', {
      expectedGeneration: '3',
      capability: ['drive.read', 'docs.publish'],
    });
    expect(calls[0]?.body).toEqual({
      action: 'set_capabilities',
      expectedGeneration: 3,
      capabilities: ['drive.read', 'docs.publish'],
    });
  });

  it('are refused before the segment is called when the CSRF token is wrong', async () => {
    const { response, calls } = await post(
      backend({ admin: true }),
      'disable',
      { expectedGeneration: '3' },
      'x'.repeat(64),
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('pass the segment refusal through when the member is not an admin', async () => {
    const { response, follow } = await post(
      backend({ mutate: { status: 403, body: { error: 'forbidden' } } }),
      'disable',
      { expectedGeneration: '3' },
    );
    expect(response.headers.location).toBe('/s/alpha/marketplace?kind=connector&error=forbidden');
    expect(await follow()).toContain('Only segment admins can change connectors.');
  });

  it.each([
    [409, 'stale_generation', 'Someone else changed this connector'],
    [400, 'capability_not_allowed', 'settings do not allow one of those capabilities'],
    [400, 'invalid_request', 'Choose at least one capability'],
  ])('explain a %i %s as something to act on', async (status, error, text) => {
    const state = backend({ admin: true, mutate: { status, body: { error } } });
    const { response, follow } = await post(state, 'set_capabilities', { expectedGeneration: '3' });
    expect(response.headers.location).toContain(`error=${error}`);
    expect(await follow()).toContain(text);
  });
});

describe('empty and error states', () => {
  it('says so when a kind has nothing listed', async () => {
    const { html, status } = await page(
      backend({ listings: { team_bot: [] } }),
      '/s/alpha/marketplace?kind=team_bot',
    );
    expect(status).toBe(200);
    expect(html).toContain('No team bots yet');
  });

  it('shows an error page, not an empty list, when the segment fails', async () => {
    const { html, status } = await page(backend({ listFails: 503 }));
    expect(status).toBe(502);
    expect(html).toContain('Something went wrong');
    expect(html).not.toContain('No connectors yet');
  });

  it('keeps the other connectors when one detail cannot be loaded', async () => {
    const { html, status } = await page(backend({ details: { google: googleDetail() } }));
    expect(status).toBe(200);
    expect(articleOf(html, 'Google')).toContain('Read Drive');
    expect(articleOf(html, 'GitHub')).toContain('could not be loaded');
  });

  it('treats a malformed listing as a bad contract', async () => {
    const bad = listing('connector', 'google', 'Google', 'enabled', { version: 'not-a-version' });
    const { status } = await page(backend({ listings: { connector: [bad] } }));
    expect(status).toBe(502);
  });
});

describe('accessibility', () => {
  it('names every card, list and control, and uses no positive tabindex', async () => {
    const { html } = await page(backend({ admin: true }));
    for (const id of ['mp-connector-google', 'mp-connector-github']) {
      expect(html).toContain(`aria-labelledby="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('aria-label="Marketplace kinds"');
    expect(html).toContain('<span class="sr-only"> for Google</span>');
    expect(html).toContain('Save capabilities for Google');
    expect(html).not.toMatch(/tabindex="[1-9]/);
    expect(html.match(/<h1>/g)).toHaveLength(1);
  });
});
