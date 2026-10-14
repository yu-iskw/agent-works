import {
  IAP_ASSERTION_HEADER,
  suspensionHistorySchema,
  suspensionResultSchema,
  suspensionSnapshotSchema,
} from '@agent-works/domain';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage } from 'node:http';

export class AdminServiceError extends Error {
  constructor(readonly status: number) {
    super('Admin service request failed');
    this.name = 'AdminServiceError';
  }
}
export function adminClient(options: WebAppOptions, request: IncomingMessage) {
  const assertion = request.headers['x-goog-iap-jwt-assertion'];
  const load = options.fetch ?? fetch;
  async function call(path: string, command?: unknown): Promise<unknown> {
    const response = await load(new URL(path, options.apiUrl), {
      method: command === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof assertion === 'string' ? { [IAP_ASSERTION_HEADER]: assertion } : {}),
      },
      ...(command === undefined ? {} : { body: JSON.stringify(command) }),
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) throw new AdminServiceError(response.status);
    return (await response.json()) as unknown;
  }
  return {
    snapshot: async () => suspensionSnapshotSchema.parse(await call('/v1/admin/suspensions')),
    history: async () => suspensionHistorySchema.parse(await call('/v1/admin/history')),
    change: async (kind: 'suspension' | 'version', command: unknown) =>
      suspensionResultSchema.parse(
        await call(kind === 'suspension' ? '/v1/admin/suspensions' : '/v1/admin/versions', command),
      ),
  };
}
