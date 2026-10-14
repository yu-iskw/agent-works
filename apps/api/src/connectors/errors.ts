export type ConnectorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_REVOKED'
  | 'STEP_UP_REQUIRED'
  | 'RESOURCE_DENIED'
  | 'QUOTA_EXHAUSTED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'INVALID_REQUEST'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_EXPIRED'
  | 'DUPLICATE_CALL';
export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorCode,
    readonly status = 422,
  ) {
    super(code);
  }
}
export function upstreamError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('AUTH_REVOKED', 401);
  if (status === 403 || status === 404) return new ConnectorError('RESOURCE_DENIED', 403);
  if (status === 429) return new ConnectorError('QUOTA_EXHAUSTED', 429);
  if (status >= 500) return new ConnectorError('UPSTREAM_UNAVAILABLE', 503);
  return new ConnectorError('INVALID_REQUEST', 422);
}
