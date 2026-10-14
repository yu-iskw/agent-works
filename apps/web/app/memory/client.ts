import { IAP_ASSERTION_HEADER } from '@agent-works/domain';
import { memoryConsentSchema, memoryItemSchema } from '@agent-works/domain/user-memory';
import { z } from 'zod';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage } from 'node:http';
const consentResponse = z.object({
  consent: memoryConsentSchema,
  notice: z.string(),
  tenantEnabled: z.boolean(),
});
const listResponse = z.object({ items: z.array(memoryItemSchema) });
export function memoryClient(options: WebAppOptions, request: IncomingMessage) {
  const assertion = request.headers['x-goog-iap-jwt-assertion'];
  async function call(path: string, body?: unknown): Promise<unknown> {
    const response = await (options.fetch ?? fetch)(new URL(path, options.apiUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof assertion === 'string' ? { [IAP_ASSERTION_HEADER]: assertion } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('memory unavailable');
    return (await response.json()) as unknown;
  }
  return {
    consent: async () => consentResponse.parse(await call('/v1/memory/consent')),
    list: async () => listResponse.parse(await call('/v1/memory')),
    export: () => call('/v1/memory/export'),
    change: (action: string, body: unknown) => call(`/v1/memory/${action}`, body),
  };
}
