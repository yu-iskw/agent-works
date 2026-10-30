// Thin typed fetch over the BFF JSON routes. Every reply must echo the document's segment; a
// mismatch is dropped before it can reach the store.

import { CSRF_HEADER } from '../../shared/contract.js';

import type { Scope } from './store/state.js';

export class SegmentMismatch extends Error {
  constructor(expected: string, got: unknown) {
    super(`reply for ${String(got)} reached ${expected}`);
    this.name = 'SegmentMismatch';
  }
}

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
  }
}

export type Api = {
  readonly get: <T extends { readonly segment: string }>(path: string) => Promise<T>;
  readonly post: <T extends { readonly segment: string }>(
    path: string,
    body: unknown,
  ) => Promise<T>;
};

export type ApiDeps = {
  readonly scope: Scope;
  readonly fetch: typeof fetch;
  readonly onUnauthenticated: () => void;
};

export function createApi(deps: ApiDeps): Api {
  async function call<T extends { readonly segment: string }>(
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const response = await deps.fetch(path, { ...init, credentials: 'same-origin' });
    if (response.status === 401) {
      deps.onUnauthenticated();
      throw new ApiFailure(401, 'unauthenticated');
    }
    const payload = (await response.json().catch(() => undefined)) as
      Record<string, unknown> | undefined;
    if (!response.ok)
      throw new ApiFailure(
        response.status,
        typeof payload?.error === 'string' ? payload.error : 'unavailable',
      );
    if (payload?.segment !== deps.scope.segment)
      throw new SegmentMismatch(deps.scope.segment, payload?.segment);
    return payload as T;
  }
  return {
    get: (path) => call(path, { method: 'GET', headers: { accept: 'application/json' } }),
    post: (path, body) =>
      call(path, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CSRF_HEADER]: deps.scope.csrf,
        },
        body: JSON.stringify(body),
      }),
  };
}
