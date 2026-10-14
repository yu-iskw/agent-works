import { docsDraftSchema, workspaceReceiptSchema } from '@agent-works/domain/workspace-tools';

import { ConnectorError } from '../errors.js';

import type { CallerCredential, GoogleHttp } from '../google-http.js';
export function createDocsAdapter(http: GoogleHttp) {
  return {
    async createDraft(
      credential: CallerCredential,
      input: unknown,
      key: string,
      signal?: AbortSignal,
    ) {
      const body = docsDraftSchema.parse(input);
      const response = await http.request({
        method: 'POST',
        path: '/documents',
        credential,
        body,
        idempotencyKey: key,
        signal,
      });
      const parsed = workspaceReceiptSchema.safeParse(response);
      if (!parsed.success || parsed.data.kind !== 'document')
        throw new ConnectorError('INVALID_RESPONSE', 502);
      return parsed.data;
    },
  };
}
