import {
  gmailDraftSchema,
  workspaceReceiptSchema,
  gmailSearchSchema,
  workspaceSourcesSchema,
} from '../../../../../packages/domain/dist/workspace-tools.js';
import { ConnectorError } from '../errors.js';

import type { CallerCredential, GoogleHttp } from '../google-http.js';
export function createGmailAdapter(http: GoogleHttp) {
  return {
    async searchThreads(credential: CallerCredential, input: unknown, signal?: AbortSignal) {
      const body = gmailSearchSchema.parse(input);
      const query = new URLSearchParams({ q: body.query, limit: String(body.limit) });
      const response = await http.request({
        method: 'GET',
        path: `/users/me/threads?${query}`,
        credential,
        signal,
      });
      return sources(response);
    },
    async createDraft(
      credential: CallerCredential,
      input: unknown,
      key: string,
      signal?: AbortSignal,
    ) {
      const body = gmailDraftSchema.parse(input);
      const response = await http.request({
        method: 'POST',
        path: '/users/me/drafts',
        credential,
        body,
        idempotencyKey: key,
        signal,
      });
      const parsed = workspaceReceiptSchema.safeParse(response);
      if (!parsed.success || parsed.data.kind !== 'draft')
        throw new ConnectorError('INVALID_RESPONSE', 502);
      return parsed.data;
    },
  };
}
function sources(value: unknown) {
  const parsed = workspaceSourcesSchema.safeParse(value);
  if (!parsed.success) throw new ConnectorError('INVALID_RESPONSE', 502);
  return parsed.data;
}
