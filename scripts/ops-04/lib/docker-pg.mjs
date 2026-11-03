import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    ...options,
  });

export function dockerAvailable() {
  try {
    docker(['info'], { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A local disposable Postgres container that keeps its port across a kill and start, so a
 * DB restart fault is a real crash and recovery. Data lives in the container layer, not tmpfs,
 * because tmpfs is emptied by a restart. Only the container this function created is touched.
 */
export async function startRestartablePostgres(openSql) {
  const port = await freePort();
  const name = `ops04-pg-${process.pid}-${Date.now()}`;
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-p',
    `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ]);
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  const waitReady = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = openSql(url);
      try {
        await probe`select 1 as ok`;
        return;
      } catch {
        await delay(200);
      } finally {
        await probe.end({ timeout: 1 });
      }
    }
    throw new Error('postgres did not become ready');
  };
  await waitReady();
  return {
    url,
    name,
    /** Crash (SIGKILL), hold the database down for downMs, start it, wait until it answers. */
    async crashAndRestart(downMs) {
      docker(['kill', '-s', 'KILL', name]);
      await delay(downMs);
      docker(['start', name]);
      await waitReady();
    },
    stop() {
      docker(['rm', '-f', name]);
      return Promise.resolve();
    },
  };
}
