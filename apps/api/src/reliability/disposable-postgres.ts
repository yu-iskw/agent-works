import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { openSql, startDisposablePostgres } from '../ledger/disposable-postgres.js';

import type { DisposablePostgres } from '../ledger/disposable-postgres.js';

/** Real isolated PostgreSQL with an in-memory data directory; never prunes Docker. */
export type DrillPostgres = DisposablePostgres & { readonly containerName?: string };
export async function startDrillPostgres(): Promise<DrillPostgres> {
  if (existsSync('/usr/lib/postgresql/16/bin/initdb')) return startDisposablePostgres();
  const name = `issue135-memory-pg-${process.pid}-${Date.now()}`;
  // All resource values are PLACEHOLDER fixture allocations, not approved capacity caps.
  execFileSync(
    'docker',
    [
      'run',
      '--pull=never',
      '-d',
      '--rm',
      '--name',
      name,
      '--tmpfs',
      '/var/lib/postgresql/data:rw,size=256m',
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ],
    { stdio: 'ignore', timeout: 30_000 },
  );
  const stop = () => {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 });
    return Promise.resolve();
  };
  let probe: ReturnType<typeof openSql> | undefined;
  try {
    const mapped = execFileSync('docker', ['port', name, '5432'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const port = mapped.trim().split(':').at(-1);
    if (port === undefined || !/^\d+$/.test(port)) throw new Error('disposable port');
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    probe = openSql(url);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await probe`select 1`;
        return { url, stop, containerName: name };
      } catch {
        await delay(100);
      }
    }
    throw new Error('in-memory PostgreSQL startup failed');
  } catch (error) {
    await stop();
    throw error;
  } finally {
    await probe?.end({ timeout: 1 });
  }
}
