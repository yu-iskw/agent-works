import { randomBytes } from 'node:crypto';

const requestIdPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function webTraceparent(requestId: string, entropyHex?: string): string | undefined {
  const traceId = traceIdFromRequestId(requestId);
  if (traceId === undefined) return undefined;
  const spanId = entropyHex ?? randomBytes(8).toString('hex');
  if (!/^[0-9a-f]{16}$/.test(spanId) || isZero(spanId)) return undefined;
  return `00-${traceId}-${spanId}-01`;
}

function traceIdFromRequestId(requestId: string): string | undefined {
  if (!requestIdPattern.test(requestId)) return undefined;
  const traceId = requestId.replaceAll('-', '').toLowerCase();
  return isZero(traceId) ? undefined : traceId;
}

function isZero(hex: string): boolean {
  return /^0+$/.test(hex);
}
