import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { createIapProxy, fakeIap, listen } from '@agent-works/fakes';

import { createIapVerifier } from '../auth/iap.js';
import { headerValue } from '../http.js';

import type { Caller } from '../auth/iap.js';

export type FakeCallers = {
  as(sub: string): Promise<Caller>;
  close(): Promise<void>;
};

export async function startFakeCallers(): Promise<FakeCallers> {
  const upstream = await listen((request) => {
    return {
      status: 200,
      body: { assertion: headerValue(request.headers, IAP_ASSERTION_HEADER) },
    };
  }, 0);
  const proxy = await listen(createIapProxy(upstream.url), 0);
  const verify = createIapVerifier({
    jwksUrl: `${proxy.url}/jwks`,
    issuer: fakeIap.issuer,
    audience: fakeIap.audience,
  });
  return {
    async as(sub) {
      const response = await fetch(`${proxy.url}/`, { headers: { 'x-fake-user': sub } });
      const body = (await response.json()) as { assertion: string };
      return verify(body.assertion);
    },
    async close() {
      await proxy.close();
      await upstream.close();
    },
  };
}
