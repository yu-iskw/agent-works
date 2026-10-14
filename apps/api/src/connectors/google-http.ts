import { ConnectorError, upstreamError } from './errors.js';

export type CallerCredential = {
  readonly subject: string;
  readonly token: string;
  readonly scopes: readonly string[];
};
type GoogleRequest = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly credential: CallerCredential;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
};
export type GoogleHttp = { request(input: GoogleRequest): Promise<unknown> };
export type GoogleHttpOptions = {
  readonly baseUrl: string;
  readonly allowedHosts?: readonly string[];
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
};
/** Offline endpoint enforcement happens before even an injected transport is invoked. */
export function createGoogleHttp(options: GoogleHttpOptions): GoogleHttp {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]', ...(options.allowedHosts ?? [])].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw new ConnectorError('INVALID_REQUEST');
  const retries = options.retries ?? 2;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3)
    throw new ConnectorError('INVALID_REQUEST');
  return {
    async request(input) {
      if (!input.credential.token || !input.credential.subject)
        throw new ConnectorError('AUTH_REQUIRED', 401);
      if (input.method === 'POST' && !input.idempotencyKey)
        throw new ConnectorError('INVALID_REQUEST');
      const url = new URL(input.path, base);
      if (url.origin !== base.origin) throw new ConnectorError('INVALID_REQUEST');
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        input.signal?.throwIfAborted();
        const result = await attemptRequest(options, input, url);
        if (result.ok) return result.body;
        if (attempt === retries || !result.retry) throw result.error;
        await (options.sleep ?? sleep)(result.delay);
      }
      throw new ConnectorError('UPSTREAM_UNAVAILABLE', 503);
    },
  };
}
async function attemptRequest(options: GoogleHttpOptions, input: GoogleRequest, url: URL) {
  try {
    const signal = AbortSignal.any([
      AbortSignal.timeout(options.timeoutMs ?? 10_000),
      ...(input.signal ? [input.signal] : []),
    ]);
    const response = await (options.fetch ?? fetch)(url, {
      method: input.method,
      redirect: 'error',
      signal,
      headers: {
        authorization: `Bearer ${input.credential.token}`,
        'content-type': 'application/json',
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    if (!response.ok)
      return {
        ok: false as const,
        error: upstreamError(response.status),
        retry: response.status === 429 || response.status >= 500,
        delay: retryDelay(response.headers.get('retry-after')),
      };
    try {
      return { ok: true as const, body: (await response.json()) as unknown };
    } catch {
      return {
        ok: false as const,
        error: new ConnectorError('INVALID_RESPONSE', 502),
        retry: false,
        delay: 0,
      };
    }
  } catch {
    input.signal?.throwIfAborted();
    return {
      ok: false as const,
      error: new ConnectorError('UPSTREAM_UNAVAILABLE', 503),
      retry: true,
      delay: 10,
    };
  }
}
function retryDelay(value: string | null): number {
  const seconds = Number(value ?? '0.01');
  return Number.isFinite(seconds) ? Math.min(1000, Math.max(10, seconds * 1000)) : 10;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
