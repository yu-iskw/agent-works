import { IAP_ASSERTION_HEADER, approvalApiSchema } from '@agent-works/domain';

import type { ApprovalApi } from '@agent-works/domain';
import type { IncomingMessage } from 'node:http';

export type ApprovalDetail = Extract<ApprovalApi, { kind: 'detail' }>;

export function createApprovalReader(options: {
  readonly apiUrl: string;
  readonly fetch?: typeof fetch;
}) {
  return async (id: string, request: IncomingMessage): Promise<ApprovalDetail | undefined> => {
    const assertion = request.headers['x-goog-iap-jwt-assertion'];
    const response = await (options.fetch ?? fetch)(
      new URL(`/v1/approvals/${encodeURIComponent(id)}`, options.apiUrl),
      {
        method: 'GET',
        headers: typeof assertion === 'string' ? { [IAP_ASSERTION_HEADER]: assertion } : {},
        signal: AbortSignal.timeout(1500),
      },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('Approval read failed');
    const approval = approvalApiSchema.parse(await response.json());
    if (approval.kind !== 'detail' || approval.id !== id)
      throw new Error('Invalid approval detail');
    return approval;
  };
}
