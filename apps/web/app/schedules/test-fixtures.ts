import { createServer } from 'node:http';

import { scheduleFixture } from '../../../../packages/domain/dist/schedule-fixtures.js';
import { scheduleHash } from '../../../../packages/domain/dist/schedule.js';

import { createSchedulesHandler } from './handler.js';

export function scheduleWebRecord() {
  const spec = scheduleFixture();
  const at = '2026-10-14T10:00:00.000Z';
  return {
    spec,
    digest: scheduleHash(spec),
    state: 'active' as const,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    cursor: at,
  };
}
export async function openSchedulesServer(load: typeof fetch) {
  const server = createServer(createSchedulesHandler({ apiUrl: 'http://api.local', fetch: load }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('address');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
