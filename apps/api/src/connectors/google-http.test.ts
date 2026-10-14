import { describe, expect, it, vi } from 'vitest';

import { createCalendarAdapter } from './calendar/adapter.js';
import { createDocsAdapter } from './docs/adapter.js';
import { createGmailAdapter } from './gmail/adapter.js';
import { createGoogleHttp } from './google-http.js';
import { docsPayload, eventPayload, draftPayload, listPayload } from './test-fixtures.js';

const credential = { subject: 'alice', token: 'opaque-token', scopes: [] };
const input = {
  method: 'POST' as const,
  path: '/documents',
  credential,
  body: { title: 'T' },
  idempotencyKey: 'key-1',
};
describe('Google HTTP offline transport', () => {
  it.each([
    'https://www.googleapis.com',
    'http://api.google.test',
    'file:///tmp/private',
    'http://user:pass@127.0.0.1',
  ])('rejects non-local endpoint %s', (baseUrl) => {
    expect(() => createGoogleHttp({ baseUrl })).toThrow('INVALID_REQUEST');
  });
  it('rejects cross-origin paths before dispatch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = createGoogleHttp({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    await expect(
      http.request({ ...input, path: 'http://other.test/documents' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only caller bearer credentials and the stable key', async () => {
    const calls: Request[] = [];
    const fetcher: typeof fetch = (url, init) => {
      calls.push(new Request(url, init));
      return Promise.resolve(Response.json({ id: 'doc-1' }));
    };
    const http = createGoogleHttp({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    await http.request(input);
    expect(calls[0].headers.get('authorization')).toBe('Bearer opaque-token');
    expect(calls[0].headers.get('idempotency-key')).toBe('key-1');
    expect(calls[0].headers.get('x-fake-user')).toBeNull();
    expect(await calls[0].json()).toEqual(input.body);
  });
  it('retries a thrown timeout preserving the request bytes', async () => {
    const bodies: (BodyInit | null | undefined)[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = (_url, init) => {
      bodies.push(init?.body);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve(Response.json({ id: 'doc-1' }));
    };
    const http = createGoogleHttp({
      baseUrl: 'http://127.0.0.1',
      fetch: fetcher,
      sleep: () => Promise.resolve(),
    });
    expect(await http.request(input)).toEqual({ id: 'doc-1' });
    expect(bodies).toEqual([JSON.stringify(input.body), JSON.stringify(input.body)]);
  });
  it('caps retry-after to the local delay budget', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        ++attempts === 1
          ? new Response('{}', { status: 429, headers: { 'retry-after': '999999' } })
          : Response.json({}),
      );
    const http = createGoogleHttp({
      baseUrl: 'http://127.0.0.1',
      fetch: fetcher,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    await http.request(input);
    expect(delays).toEqual([1000]);
  });
  it('does not retry malformed successful replies', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('private-invalid-json')),
    );
    const http = createGoogleHttp({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    await expect(http.request(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 404])('does not retry terminal provider status %s', async (status) => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('secret', { status })));
    const http = createGoogleHttp({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    await expect(http.request(input)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([-1, 4, 1.5])('rejects an invalid retry budget %s', (retries) => {
    expect(() => createGoogleHttp({ baseUrl: 'http://127.0.0.1', retries })).toThrow(
      'INVALID_REQUEST',
    );
  });
  it('requires nonempty caller identity without falling back to another token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const http = createGoogleHttp({ baseUrl: 'http://127.0.0.1', fetch: fetcher });
    await expect(
      http.request({ ...input, credential: { ...credential, subject: '' } }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stops before a second attempt when the caller cancels during retry delay', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 429 })));
    const http = createGoogleHttp({
      baseUrl: 'http://127.0.0.1',
      fetch: fetcher,
      sleep: () => {
        controller.abort(new Error('caller stopped'));
        return Promise.resolve();
      },
    });
    await expect(http.request({ ...input, signal: controller.signal })).rejects.toThrow(
      'caller stopped',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['docs', 'calendar', 'gmail'] as const)(
    'rejects a wrong receipt kind from the %s provider',
    async (family) => {
      const http = createGoogleHttp({
        baseUrl: 'http://127.0.0.1',
        fetch: () => Promise.resolve(Response.json({ id: 'object-1', kind: 'sent' })),
      });
      const operation =
        family === 'docs'
          ? createDocsAdapter(http).createDraft(credential, docsPayload, 'key')
          : family === 'calendar'
            ? createCalendarAdapter(http).createEvent(credential, eventPayload, 'key')
            : createGmailAdapter(http).createDraft(credential, draftPayload, 'key');
      await expect(operation).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 });
    },
  );
  it('rejects unclassified Calendar source data before it can reach the runner', async () => {
    const http = createGoogleHttp({
      baseUrl: 'http://127.0.0.1',
      fetch: () =>
        Promise.resolve(Response.json([{ id: 'event-1', title: 'Meeting', body: 'Unclassified' }])),
    });
    await expect(
      createCalendarAdapter(http).listEvents(credential, listPayload),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects unclassified Gmail source data before it can reach the runner', async () => {
    const http = createGoogleHttp({
      baseUrl: 'http://127.0.0.1',
      fetch: () =>
        Promise.resolve(Response.json([{ id: 'thread-1', title: 'Mail', body: 'Unclassified' }])),
    });
    await expect(
      createGmailAdapter(http).searchThreads(credential, { query: 'Mail' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
