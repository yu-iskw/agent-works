import { IAP_ASSERTION_HEADER, scheduleRecordSchema } from '@agent-works/domain';

import type { WebAppOptions } from '../web-app.js';
import type { IncomingMessage } from 'node:http';
export class ScheduleServiceError extends Error {
  constructor(readonly status: number) {
    super('Schedules service request failed');
  }
}
export function scheduleClient(options: WebAppOptions, request: IncomingMessage) {
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
    if (!response.ok) throw new ScheduleServiceError(response.status);
    return (await response.json()) as unknown;
  }
  return {
    async list() {
      const body = await call('/v1/schedules');
      if (body === null || typeof body !== 'object' || !('schedules' in body))
        throw new ScheduleServiceError(503);
      return scheduleRecordSchema.array().parse(body.schedules);
    },
    preview: (body: unknown) => call('/v1/schedules/preview', body),
    create: (body: unknown) => call('/v1/schedules', body),
    change: (body: unknown) => call('/v1/schedules/change', body),
  };
}
