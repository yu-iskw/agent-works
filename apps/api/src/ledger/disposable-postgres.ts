import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import postgres from 'postgres';

const pgBin = '/usr/lib/postgresql/16/bin';

export type DisposablePostgres = {
  readonly url: string;
  stop(): Promise<void>;
};

export function openSql(url: string): postgres.Sql {
  return postgres(url, { max: 8, connect_timeout: 2, ssl: false, fetch_types: false });
}

export async function startDisposablePostgres(): Promise<DisposablePostgres> {
  if (existsSync(join(pgBin, 'initdb'))) return startCluster();
  return startDocker();
}

function startCluster(): Promise<DisposablePostgres> {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-pg-'));
  execFileSync(
    join(pgBin, 'initdb'),
    ['-D', dir, '-A', 'trust', '--username', 'postgres', '--no-sync'],
    {
      stdio: 'ignore',
    },
  );
  return freePort().then((portNumber) => {
    execFileSync(
      join(pgBin, 'pg_ctl'),
      [
        '-D',
        dir,
        '-w',
        'start',
        '-o',
        `-c listen_addresses=127.0.0.1 -c port=${portNumber} -k ${dir}`,
      ],
      { stdio: 'ignore' },
    );
    const url = `postgres://postgres@127.0.0.1:${portNumber}/postgres`;
    return waitForPostgres(url).then(() => ({
      url,
      stop() {
        execFileSync(join(pgBin, 'pg_ctl'), ['-D', dir, '-m', 'immediate', 'stop'], {
          stdio: 'ignore',
        });
        return Promise.resolve();
      },
    }));
  });
}

function startDocker(): Promise<DisposablePostgres> {
  const name = `ledger-pg-${process.pid}-${Date.now()}`;
  execFileSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ],
    { stdio: 'ignore' },
  );
  const mapped = execFileSync('docker', ['port', name, '5432'], { encoding: 'utf8' });
  const portNumber = mapped.trim().split(':').at(-1);
  const url = `postgres://postgres@127.0.0.1:${portNumber}/postgres`;
  return waitForPostgres(url).then(() => ({
    url,
    stop() {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      return Promise.resolve();
    },
  }));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForPostgres(url: string): Promise<void> {
  const probe = openSql(url);
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await probe`select 1 as ok`;
        return;
      } catch {
        await delay(200);
      }
    }
    throw new Error('postgres did not start');
  } finally {
    await probe.end({ timeout: 1 });
  }
}
