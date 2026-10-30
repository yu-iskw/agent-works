import { SourceError } from './port.js';

export type JsonInit = {
  readonly method?: 'GET' | 'POST';
  readonly token: string;
  readonly body?: unknown;
  readonly accept?: string;
  readonly timeoutMs?: number;
};

/** Maps provider HTTP failures onto source error codes; never includes response bodies in errors. */
function errorFor(status: number): SourceError {
  if (status === 401) return new SourceError('token_expired');
  if (status === 403) return new SourceError('denied');
  if (status === 404) return new SourceError('not_found');
  if (status === 400 || status === 422) return new SourceError('invalid_scope');
  return new SourceError('unavailable', `status ${status}`);
}

export async function call(load: typeof fetch, url: string, init: JsonInit): Promise<Response> {
  let response: Response;
  try {
    response = await load(url, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${init.token}`,
        accept: init.accept ?? 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        'user-agent': 'agent-works-m1',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 20_000),
    });
  } catch {
    throw new SourceError('unavailable', 'network');
  }
  if (!response.ok) throw errorFor(response.status);
  return response;
}

export async function json<T>(load: typeof fetch, url: string, init: JsonInit): Promise<T> {
  const response = await call(load, url, init);
  return (await response.json()) as T;
}

export async function text(load: typeof fetch, url: string, init: JsonInit): Promise<string> {
  const response = await call(load, url, init);
  return response.text();
}

const STOP = new Set(
  'the and for with that this from into what which should about their there have will your when where while able task'.split(
    ' ',
  ),
);

export function keywords(query: string): readonly string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 3 && !STOP.has(word)),
    ),
  ];
}

export function score(haystack: string, words: readonly string[]): number {
  const lower = haystack.toLowerCase();
  return words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
}

/** Older than a year counts as stale; the UI shows the date either way. */
export function isStale(modifiedAt: string | null, now: Date): boolean {
  if (modifiedAt === null) return false;
  return now.getTime() - new Date(modifiedAt).getTime() > 365 * 24 * 60 * 60 * 1000;
}
